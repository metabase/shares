// ShareStore over D1 metadata + R2 blobs (decisions replatform-r2-d1,
// d1-schema-0001, versioned-publish-d1r2):
//   R2 blobs/<sha256>   file bytes, the same bytes stored once
//   D1 shares           owner, current_version (what readers see)
//   D1 versions, files  one row set per publish; 'pending' until committed
//   D1 views            view log
//
// A publish never touches the live version. It fills a new version, then
// one D1 batch (a transaction) marks it complete and moves current_version.

import type { Env } from '../env'
import { StoreError } from './types'
import type { AuditEntry, CommitFile, Manifest, ShareStore, ShareSummary, ViewLog } from './types'

const SHA = /^[0-9a-f]{64}$/
const blobKey = (sha: string) => `blobs/${sha}`

export async function sha256Hex(body: ArrayBuffer) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// "<slug>/<rest>" -> [slug, rest]
function split(path: string): [string, string] {
  const i = path.indexOf('/')
  return i < 0 ? [path, ''] : [path.slice(0, i), path.slice(i + 1)]
}

// relative file path: no leading "/", no empty, "." or ".." segment
export function validPath(p: unknown): p is string {
  return typeof p === 'string' && !!p && p.split('/').every((s) => s && s !== '.' && s !== '..')
}

// the current version's file row of a share path
const CURRENT_FILE = `SELECT f.sha256, f.size, f.content_type FROM shares s
  JOIN files f ON f.share = s.slug AND f.version = s.current_version
  WHERE s.slug = ? AND f.path = ?`

export class D1R2Store implements ShareStore {
  constructor(private env: Env) {}

  private get db() { return this.env.DB }
  private get r2() { return this.env.BLOBS }

  private ensureUser(email: string) {
    return this.db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)')
      .bind(email, Date.now())
  }

  private async blob(path: string) {
    const [slug, rest] = split(path)
    if (!rest) return null
    const row = await this.db.prepare(CURRENT_FILE).bind(slug, rest).first<{ sha256: string }>()
    return row ? this.r2.get(blobKey(row.sha256)) : null
  }

  async getText(path: string) { return (await this.blob(path))?.text() ?? null }
  async getBytes(path: string) { return (await this.blob(path))?.arrayBuffer() ?? null }
  async getStream(path: string) { return (await this.blob(path))?.body ?? null }

  // Legacy flow (bash CLI): one PUT per file into the uploader's pending
  // version of the share; finalize() commits it.
  async putFile(path: string, body: ArrayBuffer, uploader: string) {
    const [slug, rest] = split(path)
    if (!validPath(rest)) throw new StoreError(400, 'bad path')
    const sha = await sha256Hex(body)
    await this.r2.put(blobKey(sha), body)
    const version = await this.pendingVersion(slug, uploader)
    await this.db.prepare(`INSERT OR REPLACE INTO files (share, version, path, sha256, size)
      VALUES (?, ?, ?, ?, ?)`).bind(slug, version, rest, sha, body.byteLength).run()
  }

  // The uploader's pending version of the share, made when missing.
  // Concurrent PUTs of one upload race to the same row: the INSERT is
  // skipped when a pending version exists, and a PK conflict is ignored.
  private async pendingVersion(slug: string, by: string) {
    const [, , sel] = await this.db.batch<{ version: number }>([
      this.ensureUser(by),
      this.db.prepare(`INSERT INTO versions (share, version, state, created_by, created_at)
        SELECT ?1, (SELECT coalesce(max(version), 0) + 1 FROM versions WHERE share = ?1), 'pending', ?2, ?3
        WHERE NOT EXISTS (SELECT 1 FROM versions WHERE share = ?1 AND state = 'pending' AND created_by = ?2)
        ON CONFLICT DO NOTHING`).bind(slug, by, Date.now()),
      this.db.prepare(`SELECT version FROM versions WHERE share = ? AND state = 'pending' AND created_by = ?
        ORDER BY version DESC LIMIT 1`).bind(slug, by),
    ])
    const v = sel.results[0]?.version
    if (v === undefined) throw new StoreError(409, 'concurrent publish, retry')
    return v
  }

  async owner(slug: string) {
    const r = await this.db.prepare('SELECT owner FROM shares WHERE slug = ?').bind(slug).first<{ owner: string }>()
    return r?.owner ?? null
  }

  async claim(slug: string, owner: string) {
    const now = Date.now()
    await this.db.batch([
      this.ensureUser(owner),
      this.db.prepare('INSERT OR IGNORE INTO shares (slug, owner, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .bind(slug, owner, now, now),
    ])
  }

  // Nothing to heal: D1 is the record. Subdir paths are not shares.
  async manifest(slug: string) {
    if (slug.includes('/')) return null
    const s = await this.db.prepare(
      'SELECT owner, updated_at, current_version FROM shares WHERE slug = ? AND current_version IS NOT NULL',
    ).bind(slug).first<{ owner: string; updated_at: number; current_version: number }>()
    if (!s) return null
    const { results } = await this.db.prepare('SELECT path FROM files WHERE share = ? AND version = ? ORDER BY path')
      .bind(slug, s.current_version).all<{ path: string }>()
    return { files: results.map((r) => r.path), t: s.updated_at, o: s.owner } satisfies Manifest
  }

  // Commit the uploader's pending version as the share's files. Paths not
  // uploaded fail the commit; the live version stays as it is.
  async finalize(slug: string, files: string[], owner: string, by: string) {
    const pv = await this.db.prepare(`SELECT version FROM versions
      WHERE share = ? AND state = 'pending' AND created_by = ? ORDER BY version DESC LIMIT 1`)
      .bind(slug, by).first<{ version: number }>()
    if (!pv) throw new StoreError(400, 'nothing uploaded')
    const { results } = await this.db.prepare('SELECT path FROM files WHERE share = ? AND version = ?')
      .bind(slug, pv.version).all<{ path: string }>()
    const have = new Set(results.map((r) => r.path))
    const missing = files.filter((f) => !have.has(f))
    if (missing.length) throw new StoreError(400, `not uploaded: ${missing.join(', ')}`)

    const now = Date.now()
    const list = JSON.stringify(files)
    await this.db.batch([
      this.db.prepare(`DELETE FROM files WHERE share = ? AND version = ?
        AND path NOT IN (SELECT value FROM json_each(?))`).bind(slug, pv.version, list),
      this.db.prepare(`UPDATE versions SET state = 'complete', created_at = ?3,
        file_count = (SELECT count(*) FROM files WHERE share = ?1 AND version = ?2),
        total_bytes = (SELECT coalesce(sum(size), 0) FROM files WHERE share = ?1 AND version = ?2)
        WHERE share = ?1 AND version = ?2`).bind(slug, pv.version, now),
      this.db.prepare('UPDATE shares SET current_version = ?, updated_at = ? WHERE slug = ?')
        .bind(pv.version, now, slug),
    ])
    return { files: [...new Set(files)].sort(), t: now, o: owner }
  }

  // shas of the list that R2 does not have
  async missingBlobs(shas: string[]) {
    for (const s of shas) if (!SHA.test(s)) throw new StoreError(400, `bad sha256: ${s}`)
    const uniq = [...new Set(shas)]
    const heads = await Promise.all(uniq.map((s) => this.r2.head(blobKey(s))))
    return uniq.filter((_, i) => !heads[i])
  }

  async putBlob(sha: string, body: ArrayBuffer) {
    if (!SHA.test(sha)) throw new StoreError(400, 'bad sha256')
    if (await sha256Hex(body) !== sha) throw new StoreError(400, 'sha256 does not match the body')
    await this.r2.put(blobKey(sha), body)
  }

  // One version from a manifest of uploaded blobs, in one D1 batch. Sizes
  // come from R2, not from the client.
  async commit(slug: string, files: CommitFile[], by: string, message?: string) {
    if (!files.length) throw new StoreError(400, 'empty manifest')
    const paths = new Set<string>()
    for (const f of files) {
      if (typeof f !== 'object' || !f) throw new StoreError(400, 'bad file entry')
      if (!validPath(f.path)) throw new StoreError(400, `bad path: ${f.path}`)
      if (typeof f.sha256 !== 'string' || !SHA.test(f.sha256)) throw new StoreError(400, `bad sha256: ${f.sha256}`)
      if (paths.has(f.path)) throw new StoreError(400, `duplicate path: ${f.path}`)
      paths.add(f.path)
    }
    const uniq = [...new Set(files.map((f) => f.sha256))]
    const heads = await Promise.all(uniq.map((s) => this.r2.head(blobKey(s))))
    const missing = uniq.filter((_, i) => !heads[i])
    if (missing.length) throw new StoreError(400, `missing blobs: ${missing.join(' ')}`)
    const size = new Map(uniq.map((s, i) => [s, heads[i]!.size]))

    const rows = files.map((f) => ({ ...f, size: size.get(f.sha256)! }))
    const total = rows.reduce((n, r) => n + r.size, 0)
    const now = Date.now()
    // the version this batch inserts: complete versions only grow, and the
    // batch is one transaction
    const NEW = `(SELECT max(version) FROM versions WHERE share = ?1)`
    try {
      const res = await this.db.batch([
        this.ensureUser(by),
        this.db.prepare('INSERT OR IGNORE INTO shares (slug, owner, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .bind(slug, by, now, now),
        this.db.prepare(`INSERT INTO versions (share, version, state, created_by, created_at, file_count, total_bytes, message)
          SELECT ?1, coalesce(max(version), 0) + 1, 'complete', ?2, ?3, ?4, ?5, ?6 FROM versions WHERE share = ?1`)
          .bind(slug, by, now, rows.length, total, message ?? null),
        this.db.prepare(`INSERT INTO files (share, version, path, sha256, size, content_type)
          SELECT ?1, ${NEW}, json_extract(value, '$.path'), json_extract(value, '$.sha256'),
            json_extract(value, '$.size'), json_extract(value, '$.contentType') FROM json_each(?2)`)
          .bind(slug, JSON.stringify(rows)),
        this.db.prepare(`UPDATE shares SET current_version = ${NEW}, updated_at = ?2 WHERE slug = ?1`)
          .bind(slug, now),
        this.db.prepare(`SELECT ${NEW} AS version`).bind(slug),
      ])
      return (res[5].results[0] as { version: number }).version
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new StoreError(409, 'concurrent publish, retry')
      throw e
    }
  }

  // always from the top slug's current version
  async filesUnder(prefix: string) {
    const [slug, rest] = split(prefix)
    const { results } = await this.db.prepare(`SELECT f.path FROM shares s
      JOIN files f ON f.share = s.slug AND f.version = s.current_version
      WHERE s.slug = ? AND substr(f.path, 1, ?) = ? ORDER BY f.path`)
      .bind(slug, rest.length, rest).all<{ path: string }>()
    return results.map((r) => `${slug}/${r.path}`)
  }

  async shares() {
    const { results } = await this.db.prepare(`SELECT s.slug, s.owner, s.updated_at, s.public, v.file_count FROM shares s
      JOIN versions v ON v.share = s.slug AND v.version = s.current_version`)
      .all<{ slug: string; owner: string; updated_at: number; public: number; file_count: number }>()
    return new Map<string, ShareSummary>(results.map((r) =>
      [r.slug, { n: r.file_count, t: r.updated_at, o: r.owner, ...(r.public ? { pub: true } : {}) }]))
  }

  // Removes the share and (cascade) its versions, files, views and metadata,
  // then the blobs no other file row uses. Returns the live file count.
  async deleteShare(slug: string) {
    const [cur, shas] = await this.db.batch<{ n: number } & { sha256: string }>([
      this.db.prepare(`SELECT v.file_count AS n FROM shares s
        JOIN versions v ON v.share = s.slug AND v.version = s.current_version WHERE s.slug = ?`).bind(slug),
      this.db.prepare('SELECT DISTINCT sha256 FROM files WHERE share = ?').bind(slug),
      this.db.prepare('DELETE FROM shares WHERE slug = ?').bind(slug),
    ])
    const list = JSON.stringify(shas.results.map((r) => r.sha256))
    const { results } = await this.db.prepare(`SELECT value AS sha256 FROM json_each(?)
      WHERE value NOT IN (SELECT sha256 FROM files)`).bind(list).all<{ sha256: string }>()
    for (let i = 0; i < results.length; i += 1000) {
      await this.r2.delete(results.slice(i, i + 1000).map((r) => blobKey(r.sha256)))
    }
    return cur.results[0]?.n ?? 0
  }

  async rebuildAll() {
    const r = await this.db.prepare('SELECT count(*) AS n FROM shares WHERE current_version IS NOT NULL').first<{ n: number }>()
    return r?.n ?? 0
  }

  async views(slug: string) {
    const { results } = await this.db.prepare('SELECT email, n, last_at FROM views WHERE share = ?')
      .bind(slug).all<{ email: string; n: number; last_at: number }>()
    if (!results.length) return null
    return Object.fromEntries(results.map((r) => [r.email, { n: r.n, last: r.last_at }])) as ViewLog
  }

  // The 30min gap collapses reloads and auto-refresh into one view.
  async recordView(slug: string, email: string) {
    await this.db.prepare(`INSERT INTO views (share, email, n, last_at)
      SELECT ?1, ?2, 1, ?3 WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?1)
      ON CONFLICT (share, email) DO UPDATE SET n = n + 1, last_at = excluded.last_at
      WHERE excluded.last_at - views.last_at >= 1800000`).bind(slug, email, Date.now()).run()
  }

  // only a published share (current_version set) is public to readers
  async isPublic(slug: string) {
    const r = await this.db.prepare(
      'SELECT 1 AS ok FROM shares WHERE slug = ? AND public = 1 AND current_version IS NOT NULL',
    ).bind(slug).first<{ ok: number }>()
    return !!r
  }

  async setPublic(slug: string, on: boolean, by: string) {
    const [upd] = await this.db.batch([
      this.db.prepare('UPDATE shares SET public = ? WHERE slug = ?').bind(on ? 1 : 0, slug),
      this.db.prepare(`INSERT INTO audit (at, actor, action, share)
        SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?4)`)
        .bind(Date.now(), by, on ? 'public.on' : 'public.off', slug),
    ])
    if (!upd.meta.changes) throw new StoreError(404, 'not found')
  }

  async audit(limit: number) {
    const { results } = await this.db.prepare('SELECT at, actor, action, share FROM audit ORDER BY id DESC LIMIT ?')
      .bind(limit).all<AuditEntry>()
    return results
  }

  // complete versions per publisher
  async pushes() {
    const { results } = await this.db.prepare(`SELECT created_by, count(*) AS n FROM versions
      WHERE state = 'complete' GROUP BY created_by`).all<{ created_by: string; n: number }>()
    return Object.fromEntries(results.map((r) => [r.created_by, r.n]))
  }

  // versions are the count
  async countPush() {}
}
