import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { sha256Hex } from '../src/store/d1r2'
import { LIMITS, uploadToken } from '../src/web/upload'
import { APP, CONTENT, ORIGIN, api, browse, fetchWorker, sessionCookie, slug, userToken } from './helpers'

const OWNER = 'up-owner@metabase.com'
const OTHER = 'up-other@metabase.com'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

// an upload request of the page script, as a browser sends it
async function up(method: string, path: string, body: BodyInit | null, o: {
  email?: string | null; origin?: string; host?: string; token?: string | null; headers?: Record<string, string>
} = {}) {
  const host = o.host ?? ORIGIN
  const email = o.email === undefined ? OWNER : o.email
  const cookie = email ? (await sessionCookie(email)).replace(/^s=/, host === APP ? '__Host-s=' : 's=') : ''
  const token = o.token === undefined ? (email ? await uploadToken(env, email) : '') : o.token
  return fetchWorker(path, {
    method,
    body,
    headers: {
      ...(cookie && { cookie }),
      origin: o.origin ?? host,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      ...(token && { 'x-upload-token': token }),
      ...o.headers,
    },
  }, host)
}

// the page script's sequence: missing blobs, PUT each, publish
async function uploadShare(top: string, files: Record<string, string>, o: Parameters<typeof up>[3] = {},
  extra: object = {}, query = '') {
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  const missing = await up('POST', '/_up/blobs/missing', entries.map((e) => e.sha256).join('\n'), o)
  if (missing.status !== 200) return missing
  const need = new Set((await missing.text()).split('\n').filter(Boolean))
  for (const e of entries.filter((x) => need.has(x.sha256))) {
    const r = await up('PUT', `/_up/blobs/${e.sha256}`, e.body, o)
    if (r.status !== 200) return r
  }
  return up('POST', `/_up/publish/${top}${query}`,
    JSON.stringify({ files: entries.map(({ path, sha256 }) => ({ path, sha256 })), ...extra }), o)
}

describe('web upload route', () => {
  it('makes a new share with the uploaded paths, title and collection', async () => {
    const top = slug('up-new')
    const r = await uploadShare(top, { 'index.md': '# hi', 'docs/a.txt': 'a' }, {}, { title: 'Up', collection: 'up-coll' }, '?new=1')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ slug: top, version: 1 })
    const list = await (await api('GET', `/_list?prefix=${top}/`)).text()
    expect(list.trim().split('\n').sort()).toEqual([`${top}/docs/a.txt`, `${top}/index.md`])
    const page = await (await browse(`/_s/${top}`, OWNER)).text()
    expect(page).toContain('Up')
    expect(page).toContain('up-coll')
    expect((await browse(`/${top}/docs/a.txt`, OWNER)).status).toBe(200)
  })

  it('makes a new private share that only its owner can open', async () => {
    const top = slug('up-priv')
    expect((await uploadShare(top, { 'a.txt': 'p' }, {}, { visibility: 'private' }, '?new=1')).status).toBe(200)
    expect((await browse(`/_s/${top}`, OWNER)).status).toBe(200)
    expect((await browse(`/_s/${top}`, OTHER)).status).toBe(404)
  })

  it('adds a version to an own share and keeps the old one in the history', async () => {
    const top = slug('up-ver')
    expect((await uploadShare(top, { 'a.txt': 'v1' }, {}, {}, '?new=1')).status).toBe(200)
    const r = await uploadShare(top, { 'a.txt': 'v2' }, {}, { message: 'second' })
    expect(await r.json()).toMatchObject({ version: 2 })
    const versions = await (await api('GET', `/_api/shares/${top}/versions`)).json() as { version: number; message: string | null }[]
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2])
    expect(versions.find((v) => v.version === 2)?.message).toBe('second')
  })

  it('refuses a new share on a taken slug with 409', async () => {
    const top = slug('up-taken')
    expect((await uploadShare(top, { 'a.txt': 'x' }, {}, {}, '?new=1')).status).toBe(200)
    const r = await uploadShare(top, { 'a.txt': 'y' }, {}, {}, '?new=1')
    expect(r.status).toBe(409)
    expect(await r.text()).toContain('taken')
  })

  it('refuses a version of a share of another owner', async () => {
    const top = slug('up-owned')
    expect((await uploadShare(top, { 'a.txt': 'mine' }, {}, {}, '?new=1')).status).toBe(200)
    const r = await uploadShare(top, { 'a.txt': 'theirs' }, { email: OTHER })
    expect(r.status).toBe(403)
    expect(await r.text()).toContain(`owned by ${OWNER}`)
  })

  it('needs a session', async () => {
    const r = await up('POST', '/_up/blobs/missing', 'x', { email: null })
    expect(r.status).toBe(401)
  })

  it('needs the upload token of the session user', async () => {
    const top = slug('up-tok')
    expect((await uploadShare(top, { 'a.txt': 'x' }, { token: null })).status).toBe(403)
    expect((await uploadShare(top, { 'a.txt': 'x' }, { token: 'a.b.c' })).status).toBe(403)
    const other = await uploadToken(env, OTHER)
    expect((await uploadShare(top, { 'a.txt': 'x' }, { token: other })).status).toBe(403)
    expect((await api('GET', `/_list?prefix=${top}/`)).status).toBe(200)
    expect((await (await api('GET', `/_list?prefix=${top}/`)).text()).trim()).toBe('')
  })

  it('refuses another origin, no origin and a cross-site fetch', async () => {
    const body = `${await sha('x')}\n`
    expect((await up('POST', '/_up/blobs/missing', body, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await up('POST', '/_up/blobs/missing', body, { origin: '' })).status).toBe(403)
    expect((await up('POST', '/_up/blobs/missing', body, { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403)
    expect((await up('POST', '/_up/blobs/missing', body)).status).toBe(200)
  })

  it('refuses a POST from the content host origin on the app host', async () => {
    const body = `${await sha('x')}\n`
    expect((await up('POST', '/_up/blobs/missing', body, { host: APP, origin: CONTENT })).status).toBe(403)
    expect((await up('POST', '/_up/blobs/missing', body, { host: APP })).status).toBe(200)
  })

  it('is not served on the content host', async () => {
    const r = await up('POST', '/_up/blobs/missing', `${await sha('x')}\n`, { host: CONTENT })
    expect(r.status).toBe(403)
    expect(await r.text()).toContain('the API is on')
  })

  it('does not take a CLI bearer token in place of the session', async () => {
    const token = await userToken(OWNER)
    const r = await fetchWorker('/_up/blobs/missing', {
      method: 'POST', body: `${await sha('x')}\n`, headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    })
    expect(r.status).toBe(401)
  })

  it('refuses a file over the per-file limit', async () => {
    const big = new Uint8Array(LIMITS.fileBytes + 1)
    const r = await up('PUT', `/_up/blobs/${'0'.repeat(64)}`, big)
    expect(r.status).toBe(413)
    expect(await r.text()).toContain('file too large')
  })

  it('refuses more files than the file limit', async () => {
    const shas = Array.from({ length: LIMITS.files + 1 }, (_, i) => i.toString(16).padStart(64, '0'))
    expect((await up('POST', '/_up/blobs/missing', shas.join('\n'))).status).toBe(413)
    const files = shas.map((s, i) => ({ path: `f${i}.txt`, sha256: s }))
    const r = await up('POST', `/_up/publish/${slug('up-many')}`, JSON.stringify({ files }))
    expect(r.status).toBe(413)
  })

  it('puts the upload control on the shares list and on the share page of the owner only', async () => {
    const top = slug('up-ui')
    expect((await uploadShare(top, { 'a.txt': 'x' }, {}, {}, '?new=1')).status).toBe(200)
    const list = await (await browse('/', OWNER)).text()
    expect(list).toContain('data-up-mode="new"')
    // one menu button with the two pickers as menu items
    expect(list).toMatch(/<button[^>]*class="upbtn pri"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*>Upload</)
    expect(list.match(/role="menuitem"[^>]*>([^<]*)</g)?.map((m) => m.replace(/.*>|<$/g, ''))).toEqual(['Files…', 'Folder…'])
    const coll = await (await browse('/?c=up-coll', OWNER)).text()
    expect(coll).toContain('data-up-coll="up-coll"')
    const own = await (await browse(`/_s/${top}`, OWNER)).text()
    expect(own).toContain('data-up-mode="version"')
    expect(own).toMatch(/aria-haspopup="menu"[^>]*>Upload version</)
    expect(own).toContain('>Folder…<')
    const other = await (await browse(`/_s/${top}`, OTHER)).text()
    expect(other).not.toContain('data-up-token')
  })
})
