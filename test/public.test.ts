import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTENT, api, browse, fetchWorker, publish, slug, userToken } from './helpers'

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,*/*' }
const anon = (path: string, origin?: string) => fetchWorker(path, { headers: NAV }, origin)
const setPublic = (top: string, v: string, token?: string) => api('POST', `/_public/${top}`, { token, body: v })

const PAT = 'pat@metabase.com'
const SAM = 'sam@metabase.com'

const flag = (on: boolean) => {
  if (on) env.PUBLIC_SHARING = '1'
  else delete env.PUBLIC_SHARING
}
afterEach(() => flag(false))

async function published(name: string, owner = PAT) {
  const top = slug(name)
  const r = await publish(top, { 'index.md': '# Open' }, await userToken(owner))
  expect(r.status).toBe(200)
  return top
}

describe('public sharing flag off (default)', () => {
  it('refuses to make a share public', async () => {
    const top = await published('off')
    const r = await setPublic(top, 'on', await userToken(PAT))
    expect(r.status).toBe(403)
    expect(await r.text()).toBe('public sharing is disabled\n')
  })

  it('still allows making a share private', async () => {
    const top = await published('off-private')
    expect((await setPublic(top, 'off', await userToken(PAT))).status).toBe(200)
  })

  it('sends anonymous viewers of a share marked public to login', async () => {
    const top = await published('was-public')
    flag(true)
    expect((await setPublic(top, 'on', await userToken(PAT))).status).toBe(200)
    flag(false)
    const r = await anon(`/${top}/`, CONTENT)
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toContain('/_login?to=')
  })
})

describe('public sharing flag on', () => {
  it('serves a public share without login on the content host and the single host', async () => {
    flag(true)
    const top = await published('open')
    expect(await (await setPublic(top, 'on', await userToken(PAT))).text()).toBe('on\n')
    for (const origin of [CONTENT, undefined]) {
      const r = await anon(`/${top}/`, origin)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain('<title>Open</title>')
    }
  })

  it('sends anonymous viewers of a private share to login', async () => {
    flag(true)
    const top = await published('closed')
    expect((await anon(`/${top}/`, CONTENT)).status).toBe(302)
    expect((await anon('/missing-share/', CONTENT)).status).toBe(302)
  })

  it('requires login again after the owner makes the share private', async () => {
    flag(true)
    const top = await published('toggle')
    const t = await userToken(PAT)
    await setPublic(top, 'on', t)
    expect((await anon(`/${top}/`, CONTENT)).status).toBe(200)
    await setPublic(top, 'off', t)
    expect((await anon(`/${top}/`, CONTENT)).status).toBe(302)
  })

  it('keeps private pages behind login', async () => {
    flag(true)
    for (const p of ['/', '/_token', '/_stats']) {
      expect((await anon(p)).status).toBe(302)
    }
  })

  it('lets only the owner make a share public, and the owner or admin make it private', async () => {
    flag(true)
    const top = await published('owner')
    expect((await setPublic(top, 'on', await userToken(SAM))).status).toBe(403)
    expect((await setPublic(top, 'on')).status).toBe(403)
    expect((await setPublic(top, 'on', await userToken(PAT))).status).toBe(200)
    expect((await setPublic(top, 'off', await userToken(SAM))).status).toBe(403)
    expect((await setPublic(top, 'off')).status).toBe(200)
  })

  it('rejects a bad body, a bad slug and a missing share', async () => {
    flag(true)
    const t = await userToken(PAT)
    const top = await published('bad')
    expect((await setPublic(top, 'yes', t)).status).toBe(400)
    expect((await setPublic('a/b', 'on', t)).status).toBe(400)
    expect((await setPublic(slug('nope'), 'on', t)).status).toBe(404)
  })

  it('marks public shares in the admin listing', async () => {
    flag(true)
    const top = await published('listed')
    await setPublic(top, 'on', await userToken(PAT))
    const html = await (await browse('/')).text()
    const row = html.split('<tr ').find((r) => r.includes(`/${top}/`))!
    expect(row).toContain('class="pub"')
  })

  it('writes each change to the audit log, readable by admin only', async () => {
    flag(true)
    const top = await published('audited')
    const t = await userToken(PAT)
    await setPublic(top, 'on', t)
    await setPublic(top, 'off', t)
    const r = await api('GET', '/_audit?limit=1000')
    const rows = (await r.text()).split('\n').filter((l) => l.endsWith(`\t${top}`)).map((l) => l.split('\t'))
    expect(rows.map((x) => [x[1], x[2]])).toEqual([[PAT, 'public.off'], [PAT, 'public.on']])
    expect((await api('GET', '/_audit', { token: t })).status).toBe(403)
  })
})
