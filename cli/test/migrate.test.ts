// The mb-shares migration (scripts/migrate): a fake KV REST API -> export.ts
// -> plan.ts -> import.ts into `wrangler dev` (local D1 + R2) -> verify.ts.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShareInfo } from '../../src/api-types'
import { client } from '../http'
import { exportKv } from '../../scripts/migrate/export'
import { importExport } from '../../scripts/migrate/import'
import { plan, readExport } from '../../scripts/migrate/plan'
import { verifyLink } from '../../scripts/migrate/verify'

const ROOT = join(import.meta.dirname, '../..')
const PORT = 20000 + Math.floor(Math.random() * 20000)
const LOCAL = `http://localhost:${PORT}`
const ADMIN_TOKEN = 'migrate-upload-token'
const ADMIN = 'bryan@metabase.com'
const ANN = 'ann@metabase.com'
const BOB = 'bob@metabase.com'
const T0 = Date.UTC(2026, 0, 5)
const T1 = Date.UTC(2026, 2, 9)

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254])
const enc = (s: string) => new TextEncoder().encode(s)

// the old worker's KV keys: name -> value, metadata
const KV: Record<string, { v: Uint8Array; m?: object }> = {
  'alpha-x1/index.html': { v: enc('<h1>alpha</h1>'), m: { t: T0, o: ANN } },
  'alpha-x1/img/a.png': { v: PNG, m: { t: T0 + 1, o: ANN } },
  'alpha-x1/old.txt': { v: enc('left over'), m: { t: T0 - 5, o: ANN } },
  '_own/alpha-x1': { v: enc(ANN) },
  '_man/alpha-x1': { v: enc(JSON.stringify({ files: ['img/a.png', 'index.html', 'gone.md'], t: T1, o: ANN })), m: { n: 3, t: T1, o: ANN } },
  '_views/alpha-x1': { v: enc(JSON.stringify({ 'carl@metabase.com': { n: 2, last: T1 } })) },
  'legacy-y2/notes.md': { v: enc('# notes') },
  'bob-z3/r.md': { v: enc('# bob'), m: { t: T0, o: BOB } },
  '_man/bob-z3': { v: enc(JSON.stringify({ files: ['r.md'], t: T0, o: BOB })) },
  '_pushes': { v: enc(JSON.stringify({ [ANN]: 4 })) },
  '_own/ghost': { v: enc(ANN) },
  'weird//x': { v: enc('x'), m: { t: T0, o: ANN } },
}

// the Cloudflare KV REST API: two keys per page, the first value read is a 429
function fakeKvApi() {
  let throttled = false
  const names = Object.keys(KV).sort()
  return createServer((req, res) => {
    const u = new URL(req.url!, 'http://x')
    const base = '/accounts/acc/storage/kv/namespaces/ns'
    if (req.headers.authorization !== 'Bearer cf-token' || !u.pathname.startsWith(base)) {
      res.writeHead(403).end('{"success":false}')
      return
    }
    const rest = u.pathname.slice(base.length)
    if (rest === '/keys') {
      const at = Number(u.searchParams.get('cursor') || 0)
      const page = names.slice(at, at + 2)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        success: true,
        result: page.map((name) => ({ name, ...(KV[name].m ? { metadata: KV[name].m } : {}) })),
        result_info: { count: page.length, cursor: at + 2 < names.length ? String(at + 2) : '' },
      }))
      return
    }
    if (rest.startsWith('/values/')) {
      if (!throttled) { throttled = true; res.writeHead(429).end('slow down'); return }
      const v = KV[decodeURIComponent(rest.slice('/values/'.length))]
      if (!v) { res.writeHead(404).end(); return }
      res.writeHead(200).end(Buffer.from(v.v))
      return
    }
    res.writeHead(404).end()
  })
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'share-migrate-')))
const out = join(dir, 'export')
let worker: ChildProcess
let kvApi: Server

beforeAll(async () => {
  kvApi = fakeKvApi()
  await new Promise<void>((r) => kvApi.listen(0, '127.0.0.1', r))
  const state = join(dir, 'state')
  const wr = join(ROOT, 'node_modules/.bin/wrangler')
  const m = spawnSync(wr, ['d1', 'migrations', 'apply', 'shares', '--local', '--persist-to', state], {
    cwd: ROOT, env: { ...process.env, CI: '1' }, encoding: 'utf8',
  })
  if (m.status !== 0) throw new Error(`migrations: ${m.stderr}`)
  worker = spawn(wr, ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state,
    '--var', 'SESSION_SECRET:migrate-secret', '--var', `UPLOAD_TOKEN:${ADMIN_TOKEN}`], {
    cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${LOCAL}/_skill`)).ok) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('wrangler dev did not start')
})

afterAll(() => {
  worker?.kill()
  kvApi?.close()
})

describe('mb-shares migration', () => {
  it('exports every key with its metadata and bytes through the paged API', async () => {
    const { port } = kvApi.address() as AddressInfo
    const info = await exportKv({ base: `http://127.0.0.1:${port}`, account: 'acc', namespace: 'ns', token: 'cf-token' }, out, () => {})
    expect(info.keys).toBe(Object.keys(KV).length)
    const ex = readExport(out)
    expect(ex.keys.map((k) => k.name).sort()).toEqual(Object.keys(KV).sort())
    for (const k of ex.keys) {
      expect(new Uint8Array(ex.value(k))).toEqual(KV[k.name].v)
      expect(k.metadata).toEqual(KV[k.name].m)
    }
  })

  it('plans one share per slug from the manifest, owner key and file metadata', () => {
    const ex = readExport(out)
    const p = plan(ex.keys, ex.text, ADMIN, ex.info.exportedAt)
    const strip = p.shares.map(({ files, ...s }) => ({ ...s, files: files.map((f) => f.path) }))
    expect(strip).toEqual([
      {
        slug: 'alpha-x1', owner: ANN, createdBy: ANN, createdAt: T0, updatedAt: T1,
        files: ['img/a.png', 'index.html'], views: { 'carl@metabase.com': { n: 2, last: T1 } },
        unlisted: ['old.txt'], missing: ['gone.md'],
      },
      { slug: 'bob-z3', owner: BOB, createdBy: BOB, createdAt: T0, updatedAt: T0, files: ['r.md'], unlisted: [], missing: [] },
      {
        slug: 'legacy-y2', owner: ADMIN, createdBy: ADMIN, createdAt: ex.info.exportedAt, updatedAt: ex.info.exportedAt,
        files: ['notes.md'], unlisted: [], missing: [],
      },
    ])
    expect(p.skipped.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: '_pushes', why: 'bookkeeping' },
      { key: 'ghost', why: 'bookkeeping of a share without files' },
      { key: 'weird//x', why: 'bad path' },
    ])
  })

  it('imports the shares with their owners and the same bytes, and a second run changes nothing', async () => {
    const c = client(LOCAL, ADMIN_TOKEN)
    const first = await importExport(out, c, { admin: ADMIN })
    expect(first.results.map((r) => [r.slug, 'result' in r ? r.result : JSON.stringify(r)]))
      .toEqual([['alpha-x1', 'created'], ['bob-z3', 'created'], ['legacy-y2', 'created']])

    const alpha = await c.json<ShareInfo>('GET', '/_api/shares/alpha-x1')
    expect(alpha).toMatchObject({ owner: ANN, fileCount: 2, createdAt: T0, updatedAt: T1 })
    expect((await c.json<ShareInfo>('GET', '/_api/shares/bob-z3')).owner).toBe(BOB)
    expect(await c.text('GET', '/alpha-x1/_views')).toBe(`carl@metabase.com\t2\t${new Date(T1).toISOString()}\n`)

    const again = await importExport(out, c, { admin: ADMIN })
    expect(again.results.map((r) => 'result' in r && r.result)).toEqual(['same', 'same', 'same'])
  })

  it('verifies old links: files, directories and whole shares', async () => {
    const ex = readExport(out)
    const shares = new Map(plan(ex.keys, ex.text, ADMIN, ex.info.exportedAt).shares.map((s) => [s.slug, s]))
    const byFile = new Map(ex.keys.map((k) => [k.file, k]))
    const c = client(LOCAL, ADMIN_TOKEN)
    const check = (link: string) => verifyLink(c, link, shares, (f) => ex.value(byFile.get(f)!))
    const old = 'https://mb-shares.escherize.workers.dev'
    expect(await check(`${old}/alpha-x1/`)).toEqual({ link: `${old}/alpha-x1/`, ok: true, checked: 2, problems: [] })
    expect((await check(`${old}/alpha-x1/img/a.png`)).checked).toBe(1)
    expect((await check(`${old}/alpha-x1/img/`)).ok).toBe(true)
    expect((await check(`${old}/legacy-y2/notes.md`)).ok).toBe(true)
    expect(await check(`${old}/nope-q9/`)).toMatchObject({ ok: false, problems: ['not in the export'] })

    // a file that changed on the new host after the import
    await c.text('PUT', '/bob-z3/r.md', { body: '# changed' })
    await c.text('POST', '/_finalize/bob-z3', { body: 'r.md' })
    expect(await check(`${old}/bob-z3/r.md`)).toMatchObject({ ok: false, problems: ['r.md: other bytes'] })
  })
})
