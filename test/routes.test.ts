import { describe, expect, it } from 'vitest'
import { ADMIN, api, browse, fetchWorker, publish, slug, userToken } from './helpers'

describe('auth', () => {
  it('redirects a browser without a session to Google login', async () => {
    const r = await fetchWorker('/some-share/')
    expect(r.status).toBe(302)
    const loc = new URL(r.headers.get('location')!)
    expect(loc.host).toBe('accounts.google.com')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://shares.test/auth/callback')
    expect(atob(loc.searchParams.get('state')!)).toBe('/some-share/')
  })

  it('refuses writes without a valid token with 401', async () => {
    expect((await fetchWorker('/x/a.md', { method: 'PUT', body: 'x' })).status).toBe(401)
    expect((await api('PUT', '/x/a.md', { token: 't.bad.sig', body: 'x' })).status).toBe(401)
    expect((await api('PUT', '/x/a.md', { token: `shr_000000000000_${'0'.repeat(64)}`, body: 'x' })).status).toBe(401)
  })
})

describe('publish and read', () => {
  it('publishes files and lists them', async () => {
    const top = slug('report')
    expect((await publish(top, { 'index.md': '# Hello\n\nbody', 'data.csv': 'a,b\n1,2\n' })).status).toBe(200)

    expect(await (await api('GET', '/_list')).text()).toContain(`${top}\n`)
    expect(await (await api('GET', `/_list?prefix=${top}/`)).text())
      .toBe(`${top}/data.csv\n${top}/index.md\n`)
    expect(await (await api('GET', `/${top}/index.md`)).text()).toBe('# Hello\n\nbody')
  })

  it('renders markdown, csv and raw files for browsers', async () => {
    const top = slug('render')
    await publish(top, { 'index.md': '# Title here\n\n*em*', 'd.csv': 'h1,h2\nx,"y,z"\n', 'a.json': '{"k":1}' })

    const md = await browse(`/${top}/`)
    expect(md.status).toBe(200)
    const html = await md.text()
    expect(html).toContain('<title>Title here</title>')
    expect(html).toContain('<em>em</em>')

    expect(await (await browse(`/${top}/d.csv`)).text()).toContain('<td>y,z</td>')
    expect(await (await browse(`/${top}/a.json`)).text()).toContain('&quot;k&quot;: 1')
    // non-browser fetch of the same file gets the raw bytes
    const raw = await browse(`/${top}/a.json`, ADMIN, { accept: '*/*' })
    expect(raw.headers.get('content-type')).toBe('application/json')
    expect(await raw.text()).toBe('{"k":1}')
  })

  it('redirects a bare slug and a subdirectory to their trailing-slash form', async () => {
    const top = slug('dirs')
    await publish(top, { 'a.txt': 'a', 'sub/b.txt': 'b' })
    const bare = await browse(`/${top}`)
    expect(bare.status).toBe(302)
    expect(bare.headers.get('location')).toBe(`https://shares.test/${top}/`)
    const sub = await browse(`/${top}/sub`)
    expect(sub.headers.get('location')).toBe(`https://shares.test/${top}/sub/`)
    expect(await (await browse(`/${top}/`)).text()).toContain(`href="/${top}/sub/b.txt"`)
  })

  it('serves peek previews and zip downloads', async () => {
    const top = slug('peek')
    await publish(top, { 'index.md': 'line one\nline two', 'x.txt': 'x' })
    const peek = await browse(`/${top}/_peek`, ADMIN, { accept: '*/*' })
    expect(await peek.json()).toEqual({ file: 'index.md', text: 'line one\nline two' })
    const zip = await browse(`/${top}/_zip`, ADMIN, { accept: '*/*' })
    expect(zip.headers.get('content-type')).toBe('application/zip')
    expect(zip.headers.get('content-disposition')).toBe(`attachment; filename="${top}.zip"`)
  })

  it('lists only your own shares on the listing page', async () => {
    const mine = slug('mine')
    const theirs = slug('theirs')
    await publish(mine, { 'a.txt': 'a' }, await userToken('ann@metabase.com'))
    await publish(theirs, { 'a.txt': 'a' }, await userToken('bob@metabase.com'))
    const page = await (await browse('/', 'ann@metabase.com')).text()
    expect(page).toContain(`/${mine}/`)
    expect(page).not.toContain(`/${theirs}/`)
    expect(await (await browse('/')).text()).toContain(`/${theirs}/`)
  })

  it('records views of share content', async () => {
    const top = slug('views')
    await publish(top, { 'index.md': '# v' })
    await browse(`/${top}/`, 'viewer@metabase.com')
    let body = ''
    for (let i = 0; i < 20 && !body; i++) {
      body = await (await api('GET', `/${top}/_views`)).text()
      if (!body) await new Promise((r) => setTimeout(r, 50))
    }
    expect(body).toMatch(/^viewer@metabase\.com\t1\t\d{4}-/)
  })
})

describe('ownership', () => {
  it('refuses writes to a share owned by another user', async () => {
    const top = slug('owned')
    await publish(top, { 'a.txt': 'a' }, await userToken('ann@metabase.com'))
    const r = await api('PUT', `/${top}/a.txt`, { token: await userToken('bob@metabase.com'), body: 'b' })
    expect(r.status).toBe(403)
    expect(await r.text()).toBe('owned by ann@metabase.com\n')
    const d = await api('DELETE', `/${top}/`, { token: await userToken('bob@metabase.com') })
    expect(d.status).toBe(403)
  })

  it('deletes only the named share, not shares that share its prefix', async () => {
    const top = slug('a')
    const longer = `${top}lice`
    await publish(top, { 'a.txt': 'a' })
    await publish(longer, { 'b.txt': 'b' })
    expect(await (await api('DELETE', `/${top}`)).text()).toBe('deleted 1\n')
    expect((await api('GET', `/${top}/a.txt`)).status).toBe(404)
    expect(await (await api('GET', `/${longer}/b.txt`)).text()).toBe('b')
  })
})

describe('reserved and private paths', () => {
  it('rejects _-prefixed keys in the API', async () => {
    expect((await api('PUT', '/_own/x', { body: 'me' })).status).toBe(400)
    expect((await api('GET', '/_list?prefix=_own/')).status).toBe(400)
  })

  it('renders 404 for _-prefixed keys in the browser', async () => {
    expect(await (await browse('/_own/x')).text()).toContain('<h1>404</h1>')
  })

  it('answers private pages to top-level navigations only', async () => {
    for (const path of ['/', '/_token', '/_stats']) {
      const nav = await browse(path)
      expect(nav.status).toBe(200)
      expect(nav.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(nav.headers.get('x-frame-options')).toBe('DENY')
      const sub = await browse(path, ADMIN, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })
      expect(sub.status).toBe(403)
    }
  })

  it('serves the CLI script and the skill', async () => {
    expect(await (await api('GET', '/_cli')).text()).toMatch(/^#!\/usr\/bin\/env bash/)
    expect(await (await api('GET', '/_skill')).text()).toContain('share')
  })
})
