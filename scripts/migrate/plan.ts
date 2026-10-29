// The shares of an mb-shares KV export (export.ts), as the new store takes
// them (POST /_import/<slug>). KV layout of the old worker (src/store/kv.ts):
//   <slug>/<path>   file bytes, metadata { t, o } (upload time, uploader)
//   _own/<slug>     owner email
//   _man/<slug>     manifest JSON { files, t, o }
//   _views/<slug>   ViewLog JSON
//   _pushes         publish counts (not imported: the new store counts versions)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// one line of keys.jsonl
export interface ExportKey {
  name: string
  metadata?: { t?: number; o?: string } | null
  // value file, relative to the export dir
  file: string
}

export interface ExportInfo {
  account: string
  namespace: string
  exportedAt: number
  keys: number
}

export interface PlannedShare {
  slug: string
  owner: string
  createdBy: string
  createdAt: number
  updatedAt: number
  // path in the share -> value file
  files: { path: string; file: string }[]
  views?: Record<string, { n: number; last: number }>
  // keys under <slug>/ that the manifest does not name (left over after
  // `share -e`); not imported, the old listing did not show them either
  unlisted: string[]
  // manifest files without a key; not imported
  missing: string[]
}

export interface Plan {
  shares: PlannedShare[]
  // keys that are no share file and no bookkeeping of a share, with why
  skipped: { key: string; why: string }[]
}

// relative file path: no leading "/", no empty, "." or ".." segment (the
// rule of the new store, validPath in src/store/d1r2.ts)
const validPath = (p: string) => !!p && p.split('/').every((s) => s && s !== '.' && s !== '..')
const validEmail = (e: unknown): e is string => typeof e === 'string' && e.includes('@')
const validTime = (t: unknown): t is number => Number.isSafeInteger(t) && (t as number) > 0

export function readExport(dir: string) {
  const info = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8')) as ExportInfo
  const keys = readFileSync(join(dir, 'keys.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as ExportKey)
  return {
    info, keys,
    value: (k: ExportKey) => readFileSync(join(dir, k.file)),
    text: (k: ExportKey) => readFileSync(join(dir, k.file), 'utf8'),
  }
}

// admin: the owner of a share that names none (the old worker's rule)
// text: the value of a bookkeeping key as text
export function plan(keys: ExportKey[], text: (k: ExportKey) => string, admin: string, exportedAt: number): Plan {
  const skipped: Plan['skipped'] = []
  const own = new Map<string, string>()
  const man = new Map<string, { files?: unknown; t?: unknown; o?: unknown }>()
  const views = new Map<string, Record<string, { n: number; last: number }>>()
  const files = new Map<string, Map<string, ExportKey>>()

  for (const k of keys) {
    const i = k.name.indexOf('/')
    const head = i < 0 ? k.name : k.name.slice(0, i)
    const rest = i < 0 ? '' : k.name.slice(i + 1)
    if (head === '_own' || head === '_man' || head === '_views') {
      const raw = text(k)
      if (head === '_own') {
        // plain text, not JSON
        if (validEmail(raw.trim())) own.set(rest, raw.trim())
        else skipped.push({ key: k.name, why: 'bad owner' })
        continue
      }
      let v: unknown
      try { v = JSON.parse(raw) } catch { skipped.push({ key: k.name, why: 'bad JSON' }); continue }
      if (head === '_man') {
        man.set(rest, (v ?? {}) as never)
      } else if (v && typeof v === 'object') {
        views.set(rest, v as never)
      }
      continue
    }
    if (head.startsWith('_')) { skipped.push({ key: k.name, why: 'bookkeeping' }); continue }
    if (!rest) { skipped.push({ key: k.name, why: 'no path' }); continue }
    if (!validPath(rest)) { skipped.push({ key: k.name, why: 'bad path' }); continue }
    if (!files.has(head)) files.set(head, new Map())
    files.get(head)!.set(rest, k)
  }

  for (const s of [...own.keys(), ...man.keys(), ...views.keys()]) {
    if (!files.has(s)) skipped.push({ key: s, why: 'bookkeeping of a share without files' })
  }

  const shares: PlannedShare[] = []
  for (const [slug, byPath] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const m = man.get(slug)
    const listed = Array.isArray(m?.files) ? (m.files as unknown[]).filter((f): f is string => typeof f === 'string') : null
    const chosen = listed ? listed.filter((p) => byPath.has(p)) : [...byPath.keys()]
    if (!chosen.length) {
      skipped.push({ key: slug, why: 'manifest names no stored file' })
      continue
    }
    const metas = chosen.map((p) => byPath.get(p)!.metadata ?? {})
    const times = metas.map((x) => x.t).filter(validTime)
    const newest = metas.filter((x) => validTime(x.t) && validEmail(x.o)).sort((a, b) => b.t! - a.t!)[0]
    const owner = own.get(slug) ?? (validEmail(m?.o) ? m.o : undefined) ?? newest?.o ?? admin
    const createdAt = times.length ? Math.min(...times) : validTime(m?.t) ? m.t : exportedAt
    const updatedAt = Math.max(createdAt, ...times, validTime(m?.t) ? m.t : 0)
    const v = views.get(slug)
    shares.push({
      slug, owner, createdBy: newest?.o ?? owner, createdAt, updatedAt,
      files: chosen.sort().map((path) => ({ path, file: byPath.get(path)!.file })),
      ...(v ? { views: v } : {}),
      unlisted: listed ? [...byPath.keys()].filter((p) => !listed.includes(p)).sort() : [],
      missing: listed ? listed.filter((p) => !byPath.has(p)) : [],
    })
  }
  return { shares, skipped }
}
