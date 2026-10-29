// ShareStore over Workers KV, the inherited layout:
//   <slug>/<path>   file bytes, metadata { t, o } (upload time, uploader)
//   _own/<slug>     owner email
//   _man/<slug>     manifest JSON, metadata { n, t, o }
//   _views/<slug>   ViewLog JSON
//   _pushes         { email: publish count }
//
// ponytail: KV free tier (1GB total, 25MB/file, ~60s global propagation).

import type { Env } from '../env'
import type { Manifest, ShareStore, ShareSummary, ViewLog } from './types'

interface FileMeta { t?: number; o?: string }
interface ManMeta { n?: number; t?: number; o?: string }

// top-level slugs from one list() over the _man/ prefix (metadata carries
// everything). Cached ~60s per isolate; KV is ~60s eventually consistent anyway.
let topsCache: { at: number; v: Map<string, ShareSummary> | null } = { at: 0, v: null }

export class KvStore implements ShareStore {
  constructor(private env: Env) {}

  private get kv() { return this.env.SHARES }

  private async allEntries<M>(prefix?: string) {
    const out: KVNamespaceListKey<M>[] = []
    let cursor: string | undefined
    do {
      const l: KVNamespaceListResult<M> = await this.kv.list<M>({ prefix, cursor })
      out.push(...l.keys)
      cursor = l.list_complete ? undefined : l.cursor
    } while (cursor)
    return out
  }

  private async allKeys(prefix?: string) {
    return (await this.allEntries(prefix)).map((k) => k.name)
  }

  getText(path: string) { return this.kv.get(path, 'text') }
  getBytes(path: string) { return this.kv.get(path, 'arrayBuffer') }
  getStream(path: string) { return this.kv.get(path, 'stream') }

  async putFile(path: string, body: ArrayBuffer, uploader: string) {
    // timestamp feeds the listing's newest-first sort; o shows in admin view
    await this.kv.put(path, body, { metadata: { t: Date.now(), o: uploader } })
  }

  // Owner lives in a dedicated _own/<slug> key: a KV *read* per PUT instead
  // of a list -- the free tier allows 1k lists/day but 100k reads.
  owner(slug: string) { return this.kv.get(`_own/${slug}`) }
  claim(slug: string, owner: string) { return this.kv.put(`_own/${slug}`, owner) }

  // ---------- manifests ----------
  // KV bills list() at 1k/day free but get() at 100k/day, so enumeration must
  // not depend on list(). Each share keeps a _man/<top> manifest (JSON
  // {files,t,o}, same info duplicated into the key's metadata) written by the
  // CLI's finalize call after upload. Shares missing one (legacy, raw-curl
  // uploads) heal on first enumeration via a single list().

  private async writeManifest(top: string, files: string[], o: string, t: number) {
    const man: Manifest = { files: [...files].sort(), t, o }
    await this.kv.put(`_man/${top}`, JSON.stringify(man),
      { metadata: { n: man.files.length, t, o } })
    topsCache = { at: 0, v: null }
    return man
  }

  // Rebuild from a real list() -- the lazy-heal and migration path.
  private async rebuildManifest(top: string) {
    const entries = await this.allEntries<FileMeta>(`${top}/`)
    if (!entries.length) return null
    const o = (await this.owner(top))
      || entries.find((e) => e.metadata?.o)?.metadata?.o || this.env.ADMIN_EMAIL
    const t = Math.max(0, ...entries.map((e) => e.metadata?.t || 0))
    return this.writeManifest(top, entries.map((e) => e.name.slice(top.length + 1)), o, t)
  }

  // Top-level slugs only: healing a subdir path would write a spurious
  // _man/slug/subdir key that shows up as its own share.
  async manifest(top: string, { heal = true } = {}) {
    if (!heal) return this.kv.get<Manifest>(`_man/${top}`, 'json')
    if (top.includes('/')) return null
    // PUBLIC: no heal on read -- anonymous misses would each cost a KV list()
    // (1k/day). Pub shares always have a manifest (finalize writes it).
    return (await this.kv.get<Manifest>(`_man/${top}`, 'json'))
      || (this.env.PUBLIC ? null : this.rebuildManifest(top))
  }

  finalize(top: string, files: string[], owner: string, _by: string) {
    return this.writeManifest(top, files, owner, Date.now())
  }

  // always from the top slug's manifest
  async filesUnder(prefix: string) {
    const top = prefix.split('/')[0]
    const man = await this.manifest(top)
    return man ? man.files.map((f) => `${top}/${f}`).filter((n) => n.startsWith(prefix)) : []
  }

  async shares() {
    if (topsCache.v && Date.now() - topsCache.at < 60_000) return topsCache.v
    const tops = new Map<string, ShareSummary>()
    for (const k of await this.allEntries<ManMeta>('_man/')) {
      tops.set(k.name.slice('_man/'.length), {
        n: k.metadata?.n || 0, t: k.metadata?.t || 0, o: k.metadata?.o,
      })
    }
    topsCache = { at: Date.now(), v: tops }
    return tops
  }

  // Always list under `${top}/`: the raw key without its slash ("a") would
  // also match other people's shares that start with it ("alice-report-...").
  // Still a real list(): catches files a stale manifest doesn't know about.
  async deleteShare(top: string) {
    const names = await this.allKeys(`${top}/`)
    await Promise.all(names.map((n) => this.kv.delete(n)))
    await this.kv.delete(`_own/${top}`)
    await this.kv.delete(`_man/${top}`)
    await this.kv.delete(`_views/${top}`)
    topsCache = { at: 0, v: null }
    return names.length
  }

  // Full list() sweep. One-time bootstrap for pre-manifest shares.
  async rebuildAll() {
    const tops = new Set<string>()
    for (const k of await this.allKeys()) {
      if (!k.startsWith('_')) tops.add(k.split('/')[0])
    }
    for (const top of tops) {
      const man = await this.rebuildManifest(top)
      if (man && !(await this.owner(top))) await this.claim(top, man.o)
    }
    topsCache = { at: 0, v: null }
    return tops.size
  }

  views(top: string) { return this.kv.get<ViewLog>(`_views/${top}`, 'json') }

  // Read-modify-write; concurrent viewers can drop an increment -- fine for
  // analytics. The 30min gap collapses reloads and auto-refresh into one
  // view, keeping KV writes (1k/day free) negligible.
  async recordView(top: string, email: string) {
    const v = (await this.views(top)) || {}
    const e = v[email]
    if (e && Date.now() - e.last < 30 * 60_000) return
    v[email] = { n: (e?.n || 0) + 1, last: Date.now() }
    await this.kv.put(`_views/${top}`, JSON.stringify(v))
  }

  async pushes() {
    return (await this.kv.get<Record<string, number>>('_pushes', 'json')) || {}
  }

  // ponytail: single read-modify-write key, concurrent pushes can drop a count
  async countPush(who: string) {
    const pushes = await this.pushes()
    pushes[who] = (pushes[who] || 0) + 1
    await this.kv.put('_pushes', JSON.stringify(pushes))
  }
}
