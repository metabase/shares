// Check old mb-shares links against the new store: each link must give the
// same bytes on the new host as the KV export holds. With --redirect, the
// old host must also answer 301 to the same path on the content host.
//
//   SHARES_TOKEN=<token> bun scripts/migrate/verify.ts --export <dir> \
//     --url https://app.shares.metabase.fyi (--links links.txt | --sample 20) \
//     [--redirect https://shares.metabase.fyi]
//
// links.txt: one old link per line (from Slack), e.g.
// https://mb-shares.escherize.workers.dev/<slug>/<path>. A link to a share
// or a directory (trailing "/") checks every file under it.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { filePathUrl, parseLines } from '../../src/api-types'
import { sha256 } from '../../cli/files'
import { client, type Client } from '../../cli/http'
import { plan, readExport, type PlannedShare } from './plan'

export interface LinkResult {
  link: string
  ok: boolean
  checked: number // files compared
  problems: string[]
}

// "<slug>/<path>" of an old link, "" for the root
export function linkPath(link: string) {
  const u = new URL(link)
  return u.pathname.slice(1).split('/').map(decodeURIComponent).join('/')
}

export async function verifyLink(c: Client, link: string, shares: Map<string, PlannedShare>,
  bytes: (file: string) => Uint8Array, redirect?: string): Promise<LinkResult> {
  const problems: string[] = []
  const path = linkPath(link)
  const [slug, ...rest] = path.split('/')
  const sub = rest.join('/')
  const s = shares.get(slug)
  let checked = 0
  if (!s) {
    problems.push('not in the export')
  } else {
    const files = sub && !sub.endsWith('/') ? s.files.filter((f) => f.path === sub) : s.files.filter((f) => f.path.startsWith(sub))
    if (!files.length) problems.push('no such file in the export')
    if (sub === '' || sub.endsWith('/')) {
      const have = new Set(parseLines(await c.text('GET', `/_list?prefix=${encodeURIComponent(`${slug}/${sub}`)}`)))
      for (const f of files) if (!have.has(`${slug}/${f.path}`)) problems.push(`not listed: ${f.path}`)
    }
    for (const f of files) {
      const res = await c.request('GET', filePathUrl('', `${slug}/${f.path}`))
      if (!res.ok) { problems.push(`${f.path}: ${res.status}`); await res.body?.cancel(); continue }
      if (sha256(new Uint8Array(await res.arrayBuffer())) !== sha256(bytes(f.file))) problems.push(`${f.path}: other bytes`)
      checked++
    }
  }
  if (redirect) {
    const res = await fetch(link, { redirect: 'manual' })
    await res.body?.cancel()
    const u = new URL(link)
    const want = `${redirect.replace(/\/$/, '')}${u.pathname}${u.search}`
    if (res.status !== 301 || res.headers.get('location') !== want) {
      problems.push(`redirect: ${res.status} ${res.headers.get('location') ?? ''}, want 301 ${want}`)
    }
  }
  return { link, ok: !problems.length, checked, problems }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' },
      url: { type: 'string' },
      links: { type: 'string' },
      sample: { type: 'string' },
      redirect: { type: 'string' },
      old: { type: 'string', default: 'https://mb-shares.escherize.workers.dev' },
      admin: { type: 'string', default: 'bryan@metabase.com' },
    },
  })
  const token = process.env.SHARES_TOKEN
  if (!values.export || !values.url || !token || (!values.links && !values.sample)) {
    console.error('usage: SHARES_TOKEN=... bun scripts/migrate/verify.ts --export DIR --url APP_URL (--links FILE | --sample N) [--redirect CONTENT_URL]')
    process.exit(2)
  }
  const ex = readExport(values.export)
  const p = plan(ex.keys, ex.text, values.admin!, ex.info.exportedAt)
  const shares = new Map(p.shares.map((s) => [s.slug, s]))
  const byFile = new Map(ex.keys.map((k) => [k.file, k]))
  const links = values.links
    ? readFileSync(values.links, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l))
    : [...p.shares].sort(() => Math.random() - 0.5).slice(0, Number(values.sample))
        .map((s) => `${values.old!.replace(/\/$/, '')}/${encodeURIComponent(s.slug)}/`)
  const c = client(values.url.replace(/\/$/, ''), token)
  let bad = 0
  for (const l of links) {
    const r = await verifyLink(c, l, shares, (f) => ex.value(byFile.get(f)!), values.redirect)
    if (!r.ok) bad++
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.link} (${r.checked} files)${r.problems.length ? `: ${r.problems.join('; ')}` : ''}`)
  }
  console.log(`${links.length - bad}/${links.length} links ok`)
  if (bad) process.exit(1)
}
