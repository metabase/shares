// Import an mb-shares KV export (export.ts) into the new store through the
// worker API: blobs through /_blobs, then POST /_import/<slug> per share.
// Slugs, owners, uploaders, times and views stay as they were. Run it again
// after more uploads on the old worker: unchanged shares only merge views.
//
//   SHARES_TOKEN=<admin token> bun scripts/migrate/import.ts \
//     --export <dir> --url https://app.shares.metabase.fyi [--only a,b] [--dry-run]
//
// Writes <dir>/import-report.jsonl: one line per share with its result or
// error, and the keys plan.ts skipped.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { ImportRequest, ImportResponse } from '../../src/api-types'
import { parseLines } from '../../src/api-types'
import { sha256 } from '../../cli/files'
import { client, pool, type Client } from '../../cli/http'
import { plan, readExport, type PlannedShare } from './plan'

const PARALLEL = 4

export type ShareResult =
  | { slug: string; files: number; unlisted: number; missing: number }
    & (ImportResponse | { error: string } | { planned: true; owner: string; updatedAt: number })

export async function importShare(c: Client, s: PlannedShare, value: (file: string) => Uint8Array) {
  const files = s.files.map((f) => {
    const body = value(f.file)
    return { path: f.path, body, sha256: sha256(body) }
  })
  const missing = new Set(parseLines(await c.text('POST', '/_blobs/missing', { body: files.map((f) => f.sha256).join('\n') })))
  const sent = new Set<string>()
  for (const f of files) {
    if (!missing.has(f.sha256) || sent.has(f.sha256)) continue
    sent.add(f.sha256)
    await c.text('PUT', `/_blobs/${f.sha256}`, { body: f.body as Uint8Array<ArrayBuffer> })
  }
  const req: ImportRequest = {
    owner: s.owner, createdBy: s.createdBy, createdAt: s.createdAt, updatedAt: s.updatedAt,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    ...(s.views ? { views: s.views } : {}),
  }
  return c.json<ImportResponse>('POST', `/_import/${encodeURIComponent(s.slug)}`, { json: req })
}

export async function importExport(dir: string, c: Client | null, opts: { only?: string[]; admin: string }) {
  const ex = readExport(dir)
  const p = plan(ex.keys, ex.text, opts.admin, ex.info.exportedAt)
  const byFile = new Map(ex.keys.map((k) => [k.file, k]))
  const shares = opts.only ? p.shares.filter((s) => opts.only!.includes(s.slug)) : p.shares
  const results: ShareResult[] = []
  await pool(shares, PARALLEL, async (s) => {
    const base = { slug: s.slug, files: s.files.length, unlisted: s.unlisted.length, missing: s.missing.length }
    if (!c) { results.push({ ...base, planned: true, owner: s.owner, updatedAt: s.updatedAt }); return }
    try {
      results.push({ ...base, ...await importShare(c, s, (f) => ex.value(byFile.get(f)!)) })
    } catch (e) {
      results.push({ ...base, error: (e as Error).message })
    }
  })
  results.sort((a, b) => a.slug.localeCompare(b.slug))
  return { results, skipped: p.skipped }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' },
      url: { type: 'string' },
      only: { type: 'string' },
      admin: { type: 'string', default: 'bryan@metabase.com' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const token = process.env.SHARES_TOKEN
  const dry = values['dry-run']
  if (!values.export || (!dry && (!values.url || !token))) {
    console.error('usage: SHARES_TOKEN=<admin token> bun scripts/migrate/import.ts --export DIR --url APP_URL [--only a,b] [--admin EMAIL] [--dry-run]')
    process.exit(2)
  }
  const c = dry ? null : client(values.url!.replace(/\/$/, ''), token)
  const { results, skipped } = await importExport(values.export, c, {
    only: values.only?.split(',').map((s) => s.trim()).filter(Boolean), admin: values.admin!,
  })
  const report = [...results.map((r) => JSON.stringify(r)), ...skipped.map((s) => JSON.stringify({ skipped: s.key, why: s.why }))]
  writeFileSync(join(values.export, dry ? 'import-plan.jsonl' : 'import-report.jsonl'), report.join('\n') + '\n')
  const count = (f: (r: ShareResult) => boolean) => results.filter(f).length
  console.log(dry
    ? `plan: ${results.length} shares, ${skipped.length} keys skipped`
    : `created ${count((r) => 'result' in r && r.result === 'created')}, updated ${count((r) => 'result' in r && r.result === 'updated')}, ` +
      `same ${count((r) => 'result' in r && r.result === 'same')}, failed ${count((r) => 'error' in r)}, keys skipped ${skipped.length}`)
  for (const r of results) if ('error' in r) console.error(`${r.slug}: ${r.error}`)
  if (results.some((r) => 'error' in r)) process.exit(1)
}
