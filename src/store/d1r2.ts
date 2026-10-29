// ShareStore over D1 metadata + R2 blobs (decisions replatform-r2-d1,
// d1-schema-0001, versioned-publish-d1r2):
//   R2 blobs/<sha256>   file bytes, the same bytes stored once
//   D1 shares           owner, current_version (what readers see)
//   D1 versions, files  one row set per publish; 'pending' until committed
//   D1 views            view log
//   D1 collections, share_meta  collections and free-form share metadata
//
// A publish never touches the live version. It fills a new version, then
// one D1 batch (a transaction) marks it complete and moves current_version.

import type { Env } from '../env'
import { baseSlug, pinned, StoreError } from './types'
import type {
  AuditEntry, Collection, CollectionUpdate, CommitFile, Manifest, QueryStore, ShareAttrs, ShareFilter, ShareInfo,
  ShareManifest, ShareStore, ShareSummary, VersionInfo, ViewLog,
} from './types'

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

// lowercase segments joined by "/", e.g. metareview/metabase-85416
const COLLECTION = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,3}$/
const META_KEY = /^[A-Za-z0-9_.:-]{1,64}$/
const MAX_META_KEYS = 64
const MAX_META_BYTES = 8192
const MAX_TITLE = 500

export function validCollection(c: unknown): c is string {
  return typeof c === 'string' && COLLECTION.test(c)
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

function checkTitle(t: unknown) {
  if (t !== undefined && t !== null && (typeof t !== 'string' || t.length > MAX_TITLE)) {
    throw new StoreError(400, `bad title: a string of at most ${MAX_TITLE} characters`)
  }
}

// meta values as stored JSON text, null for a key to remove
function metaRows(meta: unknown, allowNull: boolean): [string, string | null][] {
  if (!isObject(meta)) throw new StoreError(400, 'bad meta: a JSON object')
  const rows = Object.entries(meta)
  if (rows.length > MAX_META_KEYS) throw new StoreError(400, `bad meta: at most ${MAX_META_KEYS} keys`)
  return rows.map(([k, v]) => {
    if (!META_KEY.test(k)) throw new StoreError(400, `bad meta key: ${k}`)
    if (v === null) {
      if (!allowNull) throw new StoreError(400, `bad meta value for ${k}: null`)
      return [k, null]
    }
    const json = JSON.stringify(v)
    if (json === undefined || json.length > MAX_META_BYTES) throw new StoreError(400, `bad meta value for ${k}`)
    return [k, json]
  })
}

function checkAttrs(a: ShareAttrs) {
  if (!isObject(a)) throw new StoreError(400, 'bad attributes')
  if (a.collection !== undefined && a.collection !== null && !validCollection(a.collection)) {
    throw new StoreError(400, `bad collection: ${a.collection}`)
  }
  checkTitle(a.title)
  if (a.meta !== undefined) metaRows(a.meta, true)
}

const parseMeta = (s: string | null) => (s ? JSON.parse(s) : {}) as Record<string, never>

interface ShareRow {
  slug: string; title: string | null; owner: string; collection: string | null; meta: string
  current_version: number; file_count: number; total_bytes: number; created_at: number; updated_at: number
}

const SHARE_SELECT = `SELECT s.slug, s.title, s.owner, s.collection, s.current_version, s.created_at, s.updated_at,
  v.file_count, v.total_bytes,
  (SELECT json_group_object(key, json(value)) FROM share_meta WHERE share = s.slug) AS meta
  FROM shares s JOIN versions v ON v.share = s.slug AND v.version = s.current_version`

const shareInfo = (r: ShareRow): ShareInfo => ({
  slug: r.slug, title: r.title, owner: r.owner, collection: r.collection, meta: parseMeta(r.meta),
  version: r.current_version, fileCount: r.file_count, totalBytes: r.total_bytes,
  createdAt: r.created_at, updatedAt: r.updated_at,
})

interface CollectionRow {
  slug: string; title: string | null; owner: string; meta: string; shares: number; created_at: number; updated_at: number
}

const COLLECTION_SELECT = `SELECT c.slug, c.title, c.owner, c.meta, c.created_at, c.updated_at,
  (SELECT count(*) FROM shares s WHERE s.collection = c.slug AND s.current_version IS NOT NULL) AS shares
  FROM collections c`

// FTS5 query of the search box: each word is a prefix term, all must match
export function searchQuery(q: string) {
  return q.split(/\s+/).filter(Boolean).slice(0, 10)
    .map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ')
}

// slug of a rename: one path segment, not reserved
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
export const validSlug = (s: unknown): s is string => typeof s === 'string' && SLUG.test(s)

const collectionInfo = (r: CollectionRow): Collection => ({
  slug: r.slug, title: r.title, owner: r.owner, meta: parseMeta(r.meta), shares: r.shares,
  createdAt: r.created_at, updatedAt: r.updated_at,
})

// the current version's file row of a share path
const CURRENT_FILE = `SELECT f.sha256, f.size, f.content_type FROM shares s
  JOIN files f ON f.share = s.slug AND f.version = s.current_version
  WHERE s.slug = ? AND f.path = ?`

// the file rows of a complete version, for "<slug>@<n>" reads (?1 slug, ?2 version)
const PINNED_VERSION = `SELECT f.path, f.sha256, v.created_at, s.owner FROM versions v
  JOIN shares s ON s.slug = v.share
  JOIN files f ON f.share = v.share AND f.version = v.version
  WHERE v.share = ?1 AND v.version = ?2 AND v.state = 'complete'`

export class D1R2Store implements ShareStore, QueryStore {
  constructor(private env: Env) {}

  private get db() { return this.env.DB }
  private get r2() { return this.env.BLOBS }

  private ensureUser(email: string) {
    return this.db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)')
      .bind(email, Date.now())
  }

  // The search row of a share, written again from its current state. Add
  // these at the end of every batch that changes a share.
  private reindex(slug: string) {
    return [
      this.db.prepare('DELETE FROM share_search WHERE slug = ?').bind(slug),
      this.db.prepare(`INSERT INTO share_search (slug, title, collection, owner, paths, meta)
        SELECT s.slug, coalesce(s.title, ''), coalesce(s.collection, ''), s.owner,
          coalesce((SELECT group_concat(path, ' ') FROM files WHERE share = s.slug AND version = s.current_version), ''),
          coalesce((SELECT group_concat(key || ' ' || value, ' ') FROM share_meta WHERE share = s.slug), '')
        FROM shares s WHERE s.slug = ? AND s.current_version IS NOT NULL`).bind(slug),
    ]
  }

  private auditRow(by: string, action: string, slug: string, detail?: object) {
    return this.db.prepare(`INSERT INTO audit (at, actor, action, share, detail)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?4)`)
      .bind(Date.now(), by, action, slug, detail ? JSON.stringify(detail) : null)
  }

  private async blob(path: string) {
    const [top, rest] = split(path)
    if (!rest) return null
    const pin = pinned(top)
    const row = await (pin
      ? this.db.prepare(`${PINNED_VERSION} AND f.path = ?3`).bind(pin.slug, pin.version, rest)
      : this.db.prepare(CURRENT_FILE).bind(top, rest)).first<{ sha256: string }>()
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

  // Statements that apply share attributes, for the end of a publish batch
  // (the share row exists by then). Every one also bumps the share's
  // collection, so collections sort by their newest publish.
  private attrStatements(slug: string, by: string, a: ShareAttrs | undefined, now: number) {
    const out: D1PreparedStatement[] = []
    if (a?.collection) {
      out.push(this.ensureUser(by), this.db.prepare(`INSERT OR IGNORE INTO collections
        (slug, owner, created_at, updated_at) VALUES (?, ?, ?, ?)`).bind(a.collection, by, now, now))
    }
    if (a?.collection !== undefined) {
      out.push(this.db.prepare('UPDATE shares SET collection = ? WHERE slug = ?').bind(a.collection, slug))
    }
    if (a?.title !== undefined) {
      out.push(this.db.prepare('UPDATE shares SET title = ? WHERE slug = ?').bind(a.title, slug))
    }
    for (const [k, v] of a?.meta === undefined ? [] : metaRows(a.meta, true)) {
      out.push(v === null
        ? this.db.prepare('DELETE FROM share_meta WHERE share = ? AND key = ?').bind(slug, k)
        : this.db.prepare(`INSERT INTO share_meta (share, key, value) VALUES (?, ?, ?)
          ON CONFLICT (share, key) DO UPDATE SET value = excluded.value`).bind(slug, k, v))
    }
    out.push(this.db.prepare(`UPDATE collections SET updated_at = ?
      WHERE slug = (SELECT collection FROM shares WHERE slug = ?)`).bind(now, slug))
    return out
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
    const pin = pinned(slug)
    if (pin) {
      const { results } = await this.db.prepare(`${PINNED_VERSION} ORDER BY f.path`).bind(pin.slug, pin.version)
        .all<{ path: string; created_at: number; owner: string }>()
      if (!results.length) return null
      return { files: results.map((r) => r.path), t: results[0].created_at, o: results[0].owner } satisfies Manifest
    }
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
  async finalize(slug: string, files: string[], owner: string, by: string, attrs?: ShareAttrs) {
    if (attrs) checkAttrs(attrs)
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
      ...this.attrStatements(slug, by, attrs, now),
      ...this.reindex(slug),
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
  async commit(slug: string, files: CommitFile[], by: string, message?: string, attrs?: ShareAttrs, owner = by) {
    if (!files.length) throw new StoreError(400, 'empty manifest')
    if (attrs) checkAttrs(attrs)
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
        this.ensureUser(owner),
        this.db.prepare('INSERT OR IGNORE INTO shares (slug, owner, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .bind(slug, owner, now, now),
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
        ...this.attrStatements(slug, owner, attrs, now),
        ...this.reindex(slug),
      ])
      return (res[6].results[0] as { version: number }).version
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new StoreError(409, 'concurrent publish, retry')
      throw e
    }
  }

  // always from the top slug's current version
  async filesUnder(prefix: string) {
    const [slug, rest] = split(prefix)
    const pin = pinned(slug)
    if (pin) {
      const { results } = await this.db.prepare(`${PINNED_VERSION} AND substr(f.path, 1, ?3) = ?4 ORDER BY f.path`)
        .bind(pin.slug, pin.version, rest.length, rest).all<{ path: string }>()
      return results.map((r) => `${slug}/${r.path}`)
    }
    const { results } = await this.db.prepare(`SELECT f.path FROM shares s
      JOIN files f ON f.share = s.slug AND f.version = s.current_version
      WHERE s.slug = ? AND substr(f.path, 1, ?) = ? ORDER BY f.path`)
      .bind(slug, rest.length, rest).all<{ path: string }>()
    return results.map((r) => `${slug}/${r.path}`)
  }

  async shares() {
    const { results } = await this.db.prepare(`SELECT s.slug, s.owner, s.title, s.updated_at, s.public, v.file_count FROM shares s
      JOIN versions v ON v.share = s.slug AND v.version = s.current_version`)
      .all<{ slug: string; owner: string; title: string | null; updated_at: number; public: number; file_count: number }>()
    return new Map<string, ShareSummary>(results.map((r) =>
      [r.slug, { n: r.file_count, t: r.updated_at, o: r.owner, ...(r.title ? { title: r.title } : {}),
        ...(r.public ? { pub: true } : {}) }]))
  }

  // Removes the share and (cascade) its versions, files, views and metadata,
  // then the blobs no other file row uses. Returns the live file count.
  // by: the audit row's actor; no audit row without it.
  async deleteShare(slug: string, by?: string) {
    const [cur, shas] = await this.db.batch<{ n: number } & { sha256: string }>([
      this.db.prepare(`SELECT v.file_count AS n FROM shares s
        JOIN versions v ON v.share = s.slug AND v.version = s.current_version WHERE s.slug = ?`).bind(slug),
      this.db.prepare('SELECT DISTINCT sha256 FROM files WHERE share = ?').bind(slug),
      ...(by ? [this.auditRow(by, 'share.delete', slug)] : []),
      this.db.prepare('DELETE FROM shares WHERE slug = ?').bind(slug),
      this.db.prepare('DELETE FROM share_search WHERE slug = ?').bind(slug),
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
    ).bind(baseSlug(slug)).first<{ ok: number }>()
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

  async collections(prefix = '') {
    const { results } = await this.db.prepare(`${COLLECTION_SELECT}
      WHERE substr(c.slug, 1, ?1) = ?2 ORDER BY c.updated_at DESC, c.slug`)
      .bind(prefix.length, prefix).all<CollectionRow>()
    return results.map(collectionInfo)
  }

  async collection(slug: string) {
    const r = await this.db.prepare(`${COLLECTION_SELECT} WHERE c.slug = ?`).bind(slug).first<CollectionRow>()
    return r ? collectionInfo(r) : null
  }

  // Makes the collection (owner = by) or updates it; the caller checks the
  // owner of an existing one.
  async putCollection(slug: string, u: CollectionUpdate, by: string) {
    if (!validCollection(slug)) throw new StoreError(400, `bad collection: ${slug}`)
    if (!isObject(u)) throw new StoreError(400, 'bad collection update')
    checkTitle(u.title)
    const meta = u.meta === undefined ? undefined : JSON.stringify(Object.fromEntries(
      metaRows(u.meta, false).map(([k, v]) => [k, JSON.parse(v!)])))
    const now = Date.now()
    await this.db.batch([
      this.ensureUser(by),
      this.db.prepare(`INSERT OR IGNORE INTO collections (slug, owner, created_at, updated_at)
        VALUES (?, ?, ?, ?)`).bind(slug, by, now, now),
      this.db.prepare(`UPDATE collections SET updated_at = ?2,
        title = CASE WHEN ?3 THEN ?4 ELSE title END,
        meta = coalesce(?5, meta) WHERE slug = ?1`)
        .bind(slug, now, u.title !== undefined ? 1 : 0, u.title ?? null, meta ?? null),
    ])
    return (await this.collection(slug))!
  }

  async setAttrs(slug: string, attrs: ShareAttrs, by: string) {
    checkAttrs(attrs)
    const now = Date.now()
    await this.db.batch([
      ...this.attrStatements(slug, by, attrs, now),
      this.db.prepare('UPDATE shares SET updated_at = ? WHERE slug = ?').bind(now, slug),
      ...this.reindex(slug),
    ])
  }

  async queryShares(f: ShareFilter) {
    const where: string[] = []
    const args: unknown[] = []
    if (f.collection !== undefined) { where.push('s.collection = ?'); args.push(f.collection) }
    if (f.owner !== undefined) { where.push('s.owner = ?'); args.push(f.owner) }
    if (f.before !== undefined) { where.push('s.updated_at < ?'); args.push(f.before) }
    for (const [k, v] of Object.entries(f.meta ?? {})) {
      // a stored value matches the query's JSON or its string form
      let json = JSON.stringify(v)
      try { json = JSON.stringify(JSON.parse(v)) } catch { /* not JSON: string form only */ }
      where.push('EXISTS (SELECT 1 FROM share_meta m WHERE m.share = s.slug AND m.key = ? AND m.value IN (?, ?))')
      args.push(k, JSON.stringify(v), json)
    }
    const { results } = await this.db.prepare(`${SHARE_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.updated_at DESC, s.slug LIMIT ?`)
      .bind(...args, f.limit).all<ShareRow>()
    return results.map(shareInfo)
  }

  async share(slug: string) {
    const r = await this.db.prepare(`${SHARE_SELECT} WHERE s.slug = ?`).bind(slug).first<ShareRow>()
    return r ? shareInfo(r) : null
  }

  async versions(slug: string) {
    const { results } = await this.db.prepare(`SELECT v.version, v.state, v.created_by, v.created_at,
      v.file_count, v.total_bytes, v.message, v.version IS s.current_version AS live
      FROM versions v JOIN shares s ON s.slug = v.share WHERE v.share = ? ORDER BY v.version DESC`)
      .bind(slug).all<{
        version: number; state: 'pending' | 'complete'; created_by: string; created_at: number
        file_count: number; total_bytes: number; message: string | null; live: number
      }>()
    return results.map((r): VersionInfo => ({
      version: r.version, state: r.state, live: !!r.live, createdBy: r.created_by, createdAt: r.created_at,
      fileCount: r.file_count, totalBytes: r.total_bytes, message: r.message,
    }))
  }

  // pending versions are not readable: their files can still change
  async shareManifest(slug: string, version?: number) {
    const v = await this.db.prepare(version === undefined
      ? 'SELECT current_version AS version FROM shares WHERE slug = ? AND current_version IS NOT NULL'
      : `SELECT version FROM versions WHERE share = ? AND version = ? AND state = 'complete'`)
      .bind(...(version === undefined ? [slug] : [slug, version])).first<{ version: number }>()
    if (!v) return null
    const { results } = await this.db.prepare(`SELECT path, sha256, size, content_type FROM files
      WHERE share = ? AND version = ? ORDER BY path`).bind(slug, v.version)
      .all<{ path: string; sha256: string; size: number; content_type: string | null }>()
    return {
      slug, version: v.version,
      files: results.map((r) => ({ path: r.path, sha256: r.sha256, size: r.size, contentType: r.content_type })),
    } satisfies ShareManifest
  }

  async search(q: string, owner: string | undefined, limit: number) {
    const match = searchQuery(q)
    if (!match) return []
    const { results } = await this.db.prepare(`${SHARE_SELECT}
      JOIN share_search ON share_search.slug = s.slug
      WHERE share_search MATCH ?1 AND (?2 IS NULL OR s.owner = ?2) ORDER BY share_search.rank LIMIT ?3`)
      .bind(match, owner ?? null, limit).all<ShareRow>()
    return results.map(shareInfo)
  }

  async blobBytes(sha: string) {
    if (!SHA.test(sha)) return null
    return (await this.r2.get(blobKey(sha)))?.arrayBuffer() ?? null
  }

  // Moves every row of the share to the new slug in one batch. The FK
  // checks wait for the end of the batch: versions and files move apart.
  async rename(slug: string, to: string, by: string) {
    if (!validSlug(to)) throw new StoreError(400, `bad slug: ${to}`)
    if (await this.owner(to)) throw new StoreError(409, `${to} exists`)
    if (!await this.owner(slug)) throw new StoreError(404, 'not found')
    const move = (table: string, col: string) =>
      this.db.prepare(`UPDATE ${table} SET ${col} = ?2 WHERE ${col} = ?1`).bind(slug, to)
    try {
      await this.db.batch([
        this.db.prepare('PRAGMA defer_foreign_keys = true'),
        this.db.prepare(`INSERT INTO shares (slug, owner, title, collection, current_version, public, created_at, updated_at)
          SELECT ?2, owner, title, collection, current_version, public, created_at, ?3 FROM shares WHERE slug = ?1`)
          .bind(slug, to, Date.now()),
        move('versions', 'share'), move('files', 'share'), move('share_meta', 'share'), move('views', 'share'),
        this.db.prepare('DELETE FROM shares WHERE slug = ?').bind(slug),
        this.db.prepare('DELETE FROM share_search WHERE slug = ?').bind(slug),
        ...this.reindex(to),
        this.auditRow(by, 'share.rename', to, { from: slug }),
      ])
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new StoreError(409, `${to} exists`)
      throw e
    }
  }

  async transfer(slug: string, to: string, by: string) {
    const from = await this.owner(slug)
    if (!from) throw new StoreError(404, 'not found')
    await this.db.batch([
      this.ensureUser(to),
      this.db.prepare('UPDATE shares SET owner = ?, updated_at = ? WHERE slug = ?').bind(to, Date.now(), slug),
      ...this.reindex(slug),
      this.auditRow(by, 'share.transfer', slug, { from, to }),
    ])
  }
}
