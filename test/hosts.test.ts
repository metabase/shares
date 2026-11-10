import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { COOKIE, CONTENT_TAG, signEmail, ticketTag } from '../src/auth'
import { APP, CONTENT, api, fetchWorker, publish, slug, userToken } from './helpers'
import { infoLink } from '../src/web/serve'
import { storeFor } from '../src/store'

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,*/*' }
// a fetch() from script in a share on the content host
const FROM_SHARE = {
  origin: CONTENT, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
}

const appCookie = async (email: string) => `${COOKIE.app}=${await signEmail(env, email, 3600)}`
const contentCookie = async (email: string) =>
  `${COOKIE.content}=${await signEmail(env, email, 3600, CONTENT_TAG)}`

const onApp = (path: string, init?: RequestInit) => fetchWorker(path, init, APP)
const onContent = (path: string, init?: RequestInit) => fetchWorker(path, init, CONTENT)

function cookieOf(res: Response) {
  return (res.headers.get('set-cookie') || '').split(';')[0]
}

describe('content host login', () => {
  it('sends a viewer without a content cookie to the app host login with the target path', async () => {
    const r = await onContent('/some-share/a.md?x=1', { headers: NAV })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(`${APP}/_login?to=${encodeURIComponent('/some-share/a.md?x=1')}`)
  })

  it('logs in through a ticket from the app host and sets a host-only content cookie', async () => {
    const top = slug('login')
    await publish(top, { 'index.md': '# Logged in' })

    const login = await onApp(`/_login?to=${encodeURIComponent(`/${top}/`)}`,
      { headers: { ...NAV, cookie: await appCookie('pat@metabase.com') } })
    expect(login.status).toBe(302)
    const next = new URL(login.headers.get('location')!)
    expect(next.origin).toBe(CONTENT)
    expect(next.pathname).toBe('/_auth')

    const auth = await onContent(next.pathname + next.search, { headers: NAV })
    expect(auth.status).toBe(302)
    expect(auth.headers.get('location')).toBe(`/${top}/`)
    const setCookie = auth.headers.get('set-cookie')!
    expect(setCookie).toMatch(/^__Host-c=/)
    expect(setCookie).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(setCookie).not.toMatch(/Domain=/i)

    const view = await onContent(`/${top}/`, { headers: { ...NAV, cookie: cookieOf(auth) } })
    expect(view.status).toBe(200)
    expect(await view.text()).toContain('<title>Logged in</title>')
  })

  it('sends a viewer without an app session to Google with the login step as the return path', async () => {
    const r = await onApp('/_login?to=%2Fx%2F', { headers: NAV })
    const loc = new URL(r.headers.get('location')!)
    expect(loc.host).toBe('accounts.google.com')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${APP}/auth/callback`)
    expect(atob(loc.searchParams.get('state')!)).toBe('/_login?to=%2Fx%2F')
  })

  it('accepts a ticket only for the target it was issued for', async () => {
    const t = await signEmail(env, 'pat@metabase.com', 60, ticketTag(`${CONTENT}/a/`))
    const ok = await onContent(`/_auth?to=${encodeURIComponent('/a/')}&t=${t}`)
    expect(ok.status).toBe(302)
    const other = await onContent(`/_auth?to=${encodeURIComponent('/b/')}&t=${t}`)
    expect(other.status).toBe(403)
    expect(other.headers.get('set-cookie')).toBeNull()
  })

  it('refuses an expired ticket', async () => {
    const t = await signEmail(env, 'pat@metabase.com', -1, ticketTag(`${CONTENT}/a/`))
    expect((await onContent(`/_auth?to=${encodeURIComponent('/a/')}&t=${t}`)).status).toBe(403)
  })

  it('refuses a ticket target that leaves the content host', async () => {
    const t = await signEmail(env, 'pat@metabase.com', 60, ticketTag(`${CONTENT}//evil.test/`))
    expect((await onContent(`/_auth?to=${encodeURIComponent('//evil.test/')}&t=${t}`)).status).toBe(403)
    const bad = await onApp(`/_login?to=${encodeURIComponent('//evil.test/')}`,
      { headers: { ...NAV, cookie: await appCookie('pat@metabase.com') } })
    expect(bad.status).toBe(400)
  })

  it('does not accept an app session or a ticket as the content cookie', async () => {
    const app = await signEmail(env, 'pat@metabase.com', 3600)
    const tkt = await signEmail(env, 'pat@metabase.com', 60, ticketTag(`${CONTENT}/a/`))
    for (const v of [app, tkt]) {
      const r = await onContent('/a/', { headers: { ...NAV, cookie: `${COOKIE.content}=${v}` } })
      expect(r.status).toBe(302)
    }
  })

  it('does not accept a content cookie on the app host', async () => {
    const r = await onApp('/', { headers: { ...NAV, cookie: await contentCookie('pat@metabase.com') } })
    expect(new URL(r.headers.get('location')!).host).toBe('accounts.google.com')
  })
})

describe('content host', () => {
  it('lets share HTML fetch sibling files of its share', async () => {
    const top = slug('sib')
    await publish(top, { 'index.html': '<script>fetch("data.json")</script>', 'data.json': '{"a":1}' })
    const r = await onContent(`/${top}/data.json`, {
      headers: { cookie: await contentCookie('pat@metabase.com'), accept: '*/*',
        'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(await r.text()).toBe('{"a":1}')
  })

  it('refuses the API and bearer tokens', async () => {
    const token = await userToken('pat@metabase.com')
    const headers = { authorization: `Bearer ${token}` }
    for (const method of ['PUT', 'POST', 'DELETE']) {
      expect((await onContent('/x/a.md', { method, headers, body: method === 'DELETE' ? undefined : 'x' })).status)
        .toBe(403)
    }
    expect((await onContent('/_list', { headers })).status).toBe(403)
    expect((await onContent('/x/a.md', { headers })).status).toBe(403)
  })

  it('sends the listing, token and stats pages to the app host', async () => {
    const cookie = await contentCookie('pat@metabase.com')
    for (const path of ['/', '/_token', '/_stats']) {
      const r = await onContent(path, { headers: { ...NAV, cookie } })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe(`${APP}${path}`)
    }
  })
})

describe('app host', () => {
  it('sends share paths to the content host', async () => {
    const r = await onApp('/report-a3f/index.md?x=1', { headers: NAV })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(`${CONTENT}/report-a3f/index.md?x=1`)
  })

  it('serves the API with a bearer token', async () => {
    const token = await userToken('ann@metabase.com')
    const top = slug('api')
    const headers = { authorization: `Bearer ${token}` }
    expect((await onApp(`/${top}/a.txt`, { method: 'PUT', body: 'a', headers })).status).toBe(200)
    expect((await onApp(`/_finalize/${top}`, { method: 'POST', body: 'a.txt', headers })).status).toBe(200)
    const r = await onApp(`/${top}/a.txt`, { headers })
    expect(await r.text()).toBe('a')
  })

  it('refuses writes with a foreign Origin', async () => {
    const token = await userToken('ann@metabase.com')
    const r = await onApp(`/${slug('o')}/a.txt`,
      { method: 'PUT', body: 'a', headers: { authorization: `Bearer ${token}`, origin: CONTENT } })
    expect(r.status).toBe(403)
  })

  it('refuses framing and answers no response with CORS headers', async () => {
    const cookie = await appCookie('pat@metabase.com')
    const top = slug('cors')
    await publish(top, { 'index.md': '# c' })
    const reqs: [string, RequestInit][] = [
      ['/', { headers: { ...NAV, cookie } }],
      ['/_token', { headers: { ...NAV, cookie } }],
      [`/${top}/_peek`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } }],
      [`/${top}/`, { headers: NAV }],
      ['/_list', { headers: { authorization: `Bearer ${await userToken('pat@metabase.com')}` } }],
      ['/_list', {}],
    ]
    for (const [path, init] of reqs) {
      const r = await onApp(path, init)
      expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(r.headers.get('x-frame-options')).toBe('DENY')
      expect(r.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('refuses requests with the app cookie that a share script sends', async () => {
    const cookie = await appCookie('pat@metabase.com')
    const top = slug('xs')
    await publish(top, { 'index.md': '# x' })
    for (const path of ['/', '/_token', '/_stats', `/${top}/_peek`, '/_login?to=%2F']) {
      const r = await onApp(path, { headers: { ...FROM_SHARE, cookie } })
      expect(r.status).toBe(403)
    }
  })

  it('links listing rows to the folder view and copies the content host link', async () => {
    const token = await userToken('lin@metabase.com')
    const top = slug('lst')
    await publish(top, { 'a.txt': 'a' }, token)
    const cookie = await appCookie('lin@metabase.com')
    const list = await (await onApp('/', { headers: { ...NAV, cookie } })).text()
    expect(list).toContain(`href="/_s/${top}"`)
    expect(list).toContain(`data-u="${CONTENT}/${top}/"`)
    expect(list).toContain(`data-p="/${top}/"`)
  })

  it('returns the first file paths from _peek and all of them with ?full', async () => {
    const top = slug('full')
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, `${i}`]))
    await publish(top, files)
    const cookie = await appCookie('pat@metabase.com')
    const short = await (await onApp(`/${top}/_peek`, { headers: { cookie } })).json<{ file: string; text: string }>()
    expect(short.file).toBe('30 files')
    expect(short.text.split('\n')).toEqual([...Object.keys(files).slice(0, 12), '… 18 more'])
    const full = await (await onApp(`/${top}/_peek?full`, { headers: { cookie } })).json<{ text: string }>()
    expect(full.text).toBe(Object.keys(files).join('\n'))
  })

  it('frames the index page from the content host with scripts in a sandbox', async () => {
    const top = slug('frm')
    await publish(top, { 'index.html': '<script>alert(1)</script>', 'a.txt': 'a' }, await userToken('pat@metabase.com'))
    const cookie = await appCookie('pat@metabase.com')
    const r = await onApp(`/_s/${top}`, { headers: { ...NAV, cookie } })
    const body = await r.text()
    expect(body).toContain(`<iframe src="${CONTENT}/${top}/index.html"`)
    expect(body).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"')
    expect(body).toContain(`<a class="fn" href="${CONTENT}/${top}/a.txt">`)
    expect(body).not.toContain('alert(1)')
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    // the content host answers the frame: it does not refuse framing
    const c = await onContent(`/${top}/index.html`, { headers: { ...NAV, 'sec-fetch-dest': 'iframe', cookie: await contentCookie('pat@metabase.com') } })
    expect(c.status).toBe(200)
    expect(c.headers.get('x-frame-options')).toBeNull()
  })

  it('logs in to the content host from a same-site frame, not from a cross-site one', async () => {
    const cookie = await appCookie('pat@metabase.com')
    const to = `/_login?to=${encodeURIComponent('/x/index.md')}`
    const frame = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', accept: 'text/html' }
    const ok = await onApp(to, { headers: { ...frame, 'sec-fetch-site': 'same-site', cookie } })
    expect(ok.status).toBe(302)
    expect(new URL(ok.headers.get('location')!).origin).toBe(CONTENT)
    const cross = await onApp(to, { headers: { ...frame, 'sec-fetch-site': 'cross-site', cookie } })
    expect(cross.status).toBe(403)
    const shareFrame = await onApp('/', { headers: { ...frame, 'sec-fetch-site': 'same-site', cookie } })
    expect(shareFrame.status).toBe(403)
  })

  it('does not count the index frame as a view', async () => {
    const top = slug('fview')
    await publish(top, { 'index.md': '# v' })
    const cookie = await contentCookie('vic@metabase.com')
    await onContent(`/${top}/index.md`, { headers: { ...NAV, 'sec-fetch-dest': 'iframe', cookie } })
    await onContent(`/${top}/index.md`, { headers: { ...NAV, cookie } })
    const views = (await (await api('GET', `/${top}/_views`)).text()).split('\n').filter(Boolean)
    expect(views.map((l) => l.split('\t').slice(0, 2))).toEqual([['vic@metabase.com', '1']])
  })

  it('gives the content host directory listing an info button to the share page', async () => {
    const top = slug('dl')
    await publish(top, { 'a.txt': 'a', 'b.txt': 'b' })
    const r = await onContent(`/${top}/`, { headers: { ...NAV, cookie: await contentCookie('pat@metabase.com') } })
    expect(await r.text()).toContain(`<div id="tbar"><a id="info" href="${APP}/_s/${top}"`)
  })

  it('links a share with an index page to that page and its info icon to the share page', async () => {
    const token = await userToken('idx@metabase.com')
    const md = slug('imd'), html = slug('ihtml'), readme = slug('irdm'), txt = slug('itxt')
    await publish(md, { 'index.md': '# i', 'a.txt': 'a' }, token)
    await publish(html, { 'index.html': '<p>i</p>', 'a.txt': 'a' }, token)
    await publish(readme, { 'README.md': '# r', 'a.txt': 'a' }, token)
    await publish(txt, { 'a.txt': 'a', 'b.txt': 'b' }, token)
    const list = await (await onApp('/', { headers: { ...NAV, cookie: await appCookie('idx@metabase.com') } })).text()
    for (const top of [md, html]) {
      expect(list).toContain(`href="${CONTENT}/${top}/" title="${top}"`)
      expect(list).toContain(`<td class="n"><a href="/_s/${top}">2 files</a></td>`)
      expect(list).toContain(`<a class="btn ic" href="/_s/${top}" aria-label="Files and details"`)
    }
    for (const top of [readme, txt]) {
      expect(list).toContain(`href="/_s/${top}" title="${top}"`)
      expect(list).not.toContain(`href="${CONTENT}/${top}/" title="${top}"`)
      expect(list).not.toContain(`<a class="btn ic" href="/_s/${top}"`)
    }
  })

  it('puts an info button next to copy on rendered pages, but not in the share page frame', async () => {
    const top = slug('inf')
    await publish(top, { 'index.md': '# i', 'a.json': '{}', 'b.csv': 'x\n1', 'c.py': 'x = 1' })
    const cookie = await contentCookie('pat@metabase.com')
    const bar = `<div id="tbar"><a id="info" href="${APP}/_s/${top}" title="files, versions and details of this share">info</a><button id="cpall"`
    for (const path of [`/${top}/`, `/${top}/index.md`, `/${top}/a.json`, `/${top}/b.csv`, `/${top}/c.py`]) {
      expect(await (await onContent(path, { headers: { ...NAV, cookie } })).text(), path).toContain(bar)
    }
    const framed = await (await onContent(`/${top}/index.md`, { headers: { ...NAV, 'sec-fetch-dest': 'iframe', cookie } })).text()
    expect(framed).toContain('<div id="tbar"><button id="cpall"')
    expect(framed).not.toContain('id="info"')
    const pin = await (await onContent(`/${top}@1/index.md`, { headers: { ...NAV, cookie } })).text()
    expect(pin).toContain(`<a id="info" href="${APP}/_s/${top}?v=1"`)
  })

  it('serves user HTML as published, with no info button', async () => {
    const top = slug('uh')
    await publish(top, { 'index.html': '<p>mine</p>' })
    const r = await onContent(`/${top}/`, { headers: { ...NAV, cookie: await contentCookie('pat@metabase.com') } })
    expect(await r.text()).toBe('<p>mine</p>')
  })

  it('starts the index frame closed on the share page when the share opens on its index page', async () => {
    const cookie = await appCookie('pat@metabase.com')
    const md = slug('fmd'), readme = slug('frdm')
    await publish(md, { 'index.md': '# i', 'a.txt': 'a' }, await userToken('pat@metabase.com'))
    await publish(readme, { 'README.md': '# r', 'a.txt': 'a' }, await userToken('pat@metabase.com'))
    const closed = await (await onApp(`/_s/${md}`, { headers: { ...NAV, cookie } })).text()
    expect(closed).toContain('<details class="rd" aria-label="index.md"><summary class="rdh">')
    const open = await (await onApp(`/_s/${readme}`, { headers: { ...NAV, cookie } })).text()
    expect(open).toContain('<details class="rd" aria-label="README.md" open><summary class="rdh">')
  })
})

// sanity: the shared helper still drives the combined host
describe('combined host', () => {
  it('keeps serving the API on one origin', async () => {
    expect((await api('GET', '/_list')).status).toBe(200)
  })
})

describe('info link', () => {
  const url = new URL(`${CONTENT}/x/index.md`)
  it('goes to the share page in the app', () => {
    expect(infoLink(url, env, storeFor(env), 'x', false)).toBe(`${APP}/_s/x`)
  })

  it('is absent on the PUBLIC deployment, in a frame and on the KV store', () => {
    expect(infoLink(url, { ...env, PUBLIC: '1' }, storeFor(env), 'x', false)).toBeUndefined()
    expect(infoLink(url, env, storeFor(env), 'x', true)).toBeUndefined()
    expect(infoLink(url, env, storeFor({ ...env, DB: undefined } as unknown as typeof env), 'x', false)).toBeUndefined()
  })
})
