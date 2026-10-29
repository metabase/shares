import { describe, expect, it } from 'vitest'
import type { ImportRequest, ImportResponse, ShareInfo, VersionInfo } from '../src/api-types'
import { sha256Hex } from '../src/store/d1r2'
import { api, slug, userToken } from './helpers'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

async function blobs(files: Record<string, string>) {
  const out = []
  for (const [path, body] of Object.entries(files)) {
    const sha256 = await sha(body)
    expect((await api('PUT', `/_blobs/${sha256}`, { body })).status).toBe(200)
    out.push({ path, sha256 })
  }
  return out
}

const T0 = Date.UTC(2026, 0, 5)
const T1 = Date.UTC(2026, 2, 9)

async function importReq(files: Record<string, string>, more: Partial<ImportRequest> = {}): Promise<ImportRequest> {
  return {
    owner: 'ann@metabase.com', createdBy: 'ann@metabase.com', createdAt: T0, updatedAt: T1,
    files: await blobs(files), ...more,
  }
}

const post = (top: string, body: unknown, token?: string) =>
  api('POST', `/_import/${top}`, { token, body: JSON.stringify(body) })

describe('POST /_import/<slug>', () => {
  it('keeps the slug, owner, uploader, times and views of the old store', async () => {
    const top = slug('old')
    const req = await importReq({ 'index.html': '<h1>old</h1>', 'data/a.csv': 'a,b\n1,2\n' }, {
      createdBy: 'bob@metabase.com',
      views: { 'carl@metabase.com': { n: 3, last: T1 + 5 } },
    })
    const r = await post(top, req)
    expect(r.status).toBe(200)
    expect(await r.json<ImportResponse>()).toEqual({ slug: top, result: 'created', version: 1 })

    expect(await (await api('GET', `/${top}/data/a.csv`)).text()).toBe('a,b\n1,2\n')
    const info = await (await api('GET', `/_api/shares/${top}`)).json<ShareInfo>()
    expect(info).toMatchObject({ owner: 'ann@metabase.com', version: 1, fileCount: 2, createdAt: T0, updatedAt: T1 })
    const [v] = await (await api('GET', `/_api/shares/${top}/versions`)).json<VersionInfo[]>()
    expect(v).toMatchObject({ createdBy: 'bob@metabase.com', createdAt: T1, message: 'imported from mb-shares' })
    expect(await (await api('GET', `/${top}/_views`)).text())
      .toBe(`carl@metabase.com\t3\t${new Date(T1 + 5).toISOString()}\n`)

    // the owner reaches the share with a token of their own
    const ann = await userToken('ann@metabase.com')
    expect((await api('GET', '/_list', { token: ann })).status).toBe(200)
    expect(await (await api('GET', '/_list', { token: ann })).text()).toContain(`${top}\n`)
  })

  it('a second import of the same files only merges the views', async () => {
    const top = slug('again')
    const files = { 'r.md': '# r' }
    await post(top, await importReq(files, { views: { 'carl@metabase.com': { n: 2, last: T1 } } }))
    const r = await post(top, await importReq(files, { views: { 'carl@metabase.com': { n: 4, last: T1 + 9 } } }))
    expect(await r.json<ImportResponse>()).toEqual({ slug: top, result: 'same', version: 1 })
    expect(await (await api('GET', `/${top}/_views`)).text())
      .toBe(`carl@metabase.com\t4\t${new Date(T1 + 9).toISOString()}\n`)
  })

  it('an import of other files makes a new live version', async () => {
    const top = slug('changed')
    await post(top, await importReq({ 'r.md': '# one' }))
    const r = await post(top, await importReq({ 'r.md': '# two' }, { updatedAt: T1 + 1000 }))
    expect(await r.json<ImportResponse>()).toEqual({ slug: top, result: 'updated', version: 2 })
    expect(await (await api('GET', `/${top}/r.md`)).text()).toBe('# two')
    expect(await (await api('GET', `/${top}@1/r.md`)).text()).toBe('# one')
  })

  it('refuses a slug that another owner has', async () => {
    const top = slug('taken')
    await post(top, await importReq({ 'r.md': '# r' }))
    const r = await post(top, await importReq({ 'r.md': '# r' }, { owner: 'dan@metabase.com' }))
    expect(r.status).toBe(409)
    expect(await r.text()).toBe('owned by ann@metabase.com\n')
  })

  it('refuses a caller that is not admin, a missing blob and a bad request', async () => {
    const top = slug('refused')
    const ann = await userToken('ann@metabase.com')
    expect((await post(top, await importReq({ 'r.md': '# r' }), ann)).status).toBe(403)
    const missing = await post(top, { ...await importReq({}), files: [{ path: 'x', sha256: 'a'.repeat(64) }] })
    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('missing blobs')
    expect((await post(top, { ...await importReq({ 'r.md': '# r' }), owner: 'nobody' })).status).toBe(400)
    expect((await post(top, { ...await importReq({ 'r.md': '# r' }), createdAt: -1 })).status).toBe(400)
    expect((await post('_own', await importReq({ 'r.md': '# r' }))).status).toBe(400)
    expect((await api('GET', `/_api/shares/${top}`)).status).toBe(404)
  })
})
