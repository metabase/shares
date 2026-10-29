import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { COOKIE, signEmail } from '../src/auth'
import type { DeviceStartResponse, TokenInfo } from '../src/api-types'
import { APP, CONTENT, ORIGIN, api, fetchWorker, sessionCookie, userToken } from './helpers'

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,*/*' }
const appCookie = async (email: string) => `${COOKIE.app}=${await signEmail(env, email, 3600)}`
const onApp = (path: string, init?: RequestInit) => fetchWorker(path, init, APP)

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const list = (token: string) => onApp('/_list', { headers: bearer(token) })

function json(path: string, body: unknown, origin = APP) {
  return fetchWorker(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, origin)
}

// an HTML form post from a page of `origin`
function formPost(path: string, fields: Record<string, string>, cookie: string, origin = APP, host = APP) {
  return fetchWorker(path, {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
  }, host)
}

async function startLogin(name = 'laptop', origin = APP) {
  const r = await json('/_device/code', { name }, origin)
  expect(r.status).toBe(200)
  return r.json<DeviceStartResponse>()
}

const poll = (d: DeviceStartResponse, origin = APP) => json('/_device/token', { device_code: d.device_code }, origin)

describe('CLI tokens', () => {
  it('stores only the hash of a token', async () => {
    const token = await userToken('hal@metabase.com')
    const row = await env.DB.prepare('SELECT hash FROM tokens WHERE owner = ?').bind('hal@metabase.com').first<{ hash: string }>()
    expect(row!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM tokens').all())).not.toContain(token)
  })

  it('gives 401 to a token at once after share logout revokes it', async () => {
    const token = await userToken('lou@metabase.com')
    expect((await list(token)).status).toBe(200)
    const out = await onApp('/_api/tokens/current', { method: 'DELETE', headers: bearer(token) })
    expect(out.status).toBe(200)
    expect((await list(token)).status).toBe(401)
    expect((await onApp('/_api/tokens/current', { method: 'DELETE', headers: bearer(token) })).status).toBe(401)
    const { results } = await env.DB.prepare("SELECT action FROM audit WHERE actor = 'lou@metabase.com' ORDER BY id")
      .all<{ action: string }>()
    expect(results.map((r) => r.action)).toEqual(['token.create', 'token.revoke'])
  })

  it('gives 401 to an expired token', async () => {
    const token = await userToken('exp@metabase.com', 'old')
    await env.DB.prepare("UPDATE tokens SET expires_at = ? WHERE owner = 'exp@metabase.com'").bind(Date.now() - 1).run()
    expect((await list(token)).status).toBe(401)
  })

  it('lists the tokens of the caller without secrets and records the last use', async () => {
    const token = await userToken('lis@metabase.com', 'one')
    await userToken('lis@metabase.com', 'two')
    await userToken('other@metabase.com', 'not mine')
    const r = await onApp('/_api/tokens', { headers: bearer(token) })
    const tokens = await r.json<TokenInfo[]>()
    expect(tokens.map((t) => t.name).sort()).toEqual(['one', 'two'])
    expect(tokens.find((t) => t.name === 'one')!.last_used_at).toBeGreaterThan(0)
    expect(JSON.stringify(tokens)).not.toMatch(/hash|shr_/)
  })

  it('revokes only tokens of the caller', async () => {
    await userToken('vic@metabase.com', 'victim')
    const { id } = (await env.DB.prepare("SELECT id FROM tokens WHERE owner = 'vic@metabase.com'").first<{ id: string }>())!
    const r = await onApp(`/_api/tokens/${id}`, { method: 'DELETE', headers: bearer(await userToken('mal@metabase.com')) })
    expect(r.status).toBe(404)
    const row = await env.DB.prepare('SELECT revoked_at FROM tokens WHERE id = ?').bind(id).first<{ revoked_at: number | null }>()
    expect(row!.revoked_at).toBeNull()
  })

  it('refuses to revoke the shared UPLOAD_TOKEN', async () => {
    const r = await onApp('/_api/tokens/current', { method: 'DELETE', headers: bearer(env.UPLOAD_TOKEN!) })
    expect(r.status).toBe(400)
    expect((await list(env.UPLOAD_TOKEN!)).status).toBe(200)
  })
})

describe('token page', () => {
  it('creates a token, shows it once, and revokes it with a 401 after', async () => {
    const cookie = await appCookie('pag@metabase.com')
    const made = await formPost('/_token', { action: 'create', name: 'by hand' }, cookie)
    expect(made.status).toBe(200)
    const html = await made.text()
    const token = html.match(/shr_[0-9a-f]{12}_[0-9a-f]{64}/)![0]
    expect(html).toContain(`'${APP}' '${CONTENT}'`)
    expect((await list(token)).status).toBe(200)

    const page = await (await onApp('/_token', { headers: { ...NAV, cookie } })).text()
    expect(page).toContain('by hand')
    expect(page).not.toContain(token)

    const id = token.split('_')[1]
    const rev = await formPost('/_token', { action: 'revoke', id }, cookie)
    expect(rev.status).toBe(303)
    expect((await list(token)).status).toBe(401)
  })

  it('refuses form posts from another origin or without an Origin', async () => {
    const cookie = await appCookie('csrf@metabase.com')
    expect((await formPost('/_token', { action: 'create', name: 'x' }, cookie, CONTENT)).status).toBe(403)
    const noOrigin = await fetchWorker('/_token', {
      method: 'POST', body: new URLSearchParams({ action: 'create', name: 'x' }),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    }, APP)
    expect(noOrigin.status).toBe(403)
    const n = await env.DB.prepare("SELECT count(*) AS n FROM tokens WHERE owner = 'csrf@metabase.com'").first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('serves the CLI script and skill without a token', async () => {
    expect(await (await onApp('/_cli')).text()).toMatch(/^#!\/usr\/bin\/env bash/)
    expect((await onApp('/_skill')).status).toBe(200)
  })

  it('serves install.sh with the app origin as the login URL', async () => {
    for (const path of ['/install.sh', '/_install.sh']) {
      const sh = await (await onApp(path)).text()
      expect(sh).toMatch(/^#!\/bin\/sh/)
      expect(sh).toContain(`APP_URL="${APP}"`)
    }
    expect(await (await fetchWorker('/_install.sh')).text()).toContain(`APP_URL="${ORIGIN}"`)
  })

  it('shows the install.sh line on the token page', async () => {
    const html = await (await onApp('/_token', { headers: { ...NAV, cookie: await appCookie('page@metabase.com') } })).text()
    expect(html).toContain(`curl -fsSL ${APP}/install.sh | sh`)
  })

  it('tells the caller who the token belongs to', async () => {
    const res = await onApp('/_api/whoami', { headers: bearer(await userToken('who@metabase.com')) })
    expect(await res.json()).toMatchObject({ kind: 'user', email: 'who@metabase.com', admin: false })
    const up = await onApp('/_api/whoami', { headers: bearer(env.UPLOAD_TOKEN!) })
    expect(await up.json()).toEqual({ kind: 'user', email: env.ADMIN_EMAIL, admin: true, token: null })
  })
})

describe('share login device flow', () => {
  it('gives the CLI a token after the signed-in user approves the code', async () => {
    const d = await startLogin('work laptop')
    expect(d.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(d.verification_uri_complete).toBe(`${APP}/cli?code=${d.user_code}`)
    expect(d.base_url).toBe(APP)
    expect(d.content_url).toBe(CONTENT)

    const pending = await poll(d)
    expect(pending.status).toBe(400)
    expect(await pending.json()).toEqual({ error: 'authorization_pending' })

    const cookie = await appCookie('dev@metabase.com')
    const page = await onApp(`/cli?code=${d.user_code}`, { headers: { ...NAV, cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain(d.user_code)
    expect(html).toContain('work laptop')

    const ok = await formPost('/cli', { code: d.user_code, action: 'approve' }, cookie)
    expect(ok.status).toBe(200)

    const done = await poll(d)
    expect(done.status).toBe(200)
    const { token, email, name } = await done.json<{ token: string; email: string; name: string }>()
    expect([email, name]).toEqual(['dev@metabase.com', 'work laptop'])
    expect((await list(token)).status).toBe(200)

    // the device code works once
    expect(await (await poll(d)).json()).toEqual({ error: 'expired_token' })
  })

  it('sends a viewer without a session to Google and back to the approve page', async () => {
    const r = await onApp('/cli?code=BCDF-GHJK', { headers: NAV })
    const loc = new URL(r.headers.get('location')!)
    expect(loc.host).toBe('accounts.google.com')
    expect(atob(loc.searchParams.get('state')!)).toBe('/cli?code=BCDF-GHJK')
  })

  it('creates no token when the user denies the code', async () => {
    const d = await startLogin()
    const cookie = await appCookie('den@metabase.com')
    expect((await formPost('/cli', { code: d.user_code, action: 'deny' }, cookie)).status).toBe(200)
    expect(await (await poll(d)).json()).toEqual({ error: 'access_denied' })
    const n = await env.DB.prepare("SELECT count(*) AS n FROM tokens WHERE owner = 'den@metabase.com'").first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('refuses an approve post from a share on the content host', async () => {
    const d = await startLogin()
    const cookie = await appCookie('xs@metabase.com')
    expect((await formPost('/cli', { code: d.user_code, action: 'approve' }, cookie, CONTENT)).status).toBe(403)
    expect(await (await poll(d)).json()).toEqual({ error: 'authorization_pending' })
  })

  it('refuses an expired code', async () => {
    const d = await startLogin()
    await env.DB.prepare('UPDATE device_codes SET expires_at = ? WHERE user_code = ?')
      .bind(Date.now() - 1, d.user_code.replace('-', '')).run()
    const cookie = await appCookie('old@metabase.com')
    expect((await formPost('/cli', { code: d.user_code, action: 'approve' }, cookie)).status).toBe(404)
    expect(await (await poll(d)).json()).toEqual({ error: 'expired_token' })
  })

  it('accepts a typed code in lower case and without the dash', async () => {
    const d = await startLogin()
    const cookie = await appCookie('typ@metabase.com')
    const typed = d.user_code.replace('-', '').toLowerCase()
    expect((await formPost('/cli', { code: typed, action: 'approve' }, cookie)).status).toBe(200)
    expect((await poll(d)).status).toBe(200)
  })

  it('runs on the combined host with the approve page at /_device', async () => {
    const d = await startLogin('dev box', ORIGIN)
    expect(d.verification_uri).toBe(`${ORIGIN}/_device`)
    const cookie = await sessionCookie('one@metabase.com')
    const page = await fetchWorker(`/_device?code=${d.user_code}`, { headers: { ...NAV, cookie } })
    expect(await page.text()).toContain(d.user_code)
    expect((await formPost('/_device', { code: d.user_code, action: 'approve' }, cookie, ORIGIN, ORIGIN)).status).toBe(200)
    const { token } = await (await poll(d, ORIGIN)).json<{ token: string }>()
    expect((await api('GET', '/_list', { token })).status).toBe(200)
  })
})
