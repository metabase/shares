import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Collection, ServiceTokenCreated, ShareInfo } from '../src/api-types'
import { COOKIE, CONTENT_TAG, signEmail } from '../src/auth'
import { sha256Hex } from '../src/store/d1r2'
import { ADMIN, APP, CONTENT, ORIGIN, api, fetchWorker, slug, userToken } from './helpers'

const PAT = 'pat@metabase.com' // owner of the private share
const SAM = 'sam@metabase.com' // another member

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,*/*' }

const flag = (on: boolean) => {
  if (on) env.PUBLIC_SHARING = '1'
  else delete env.PUBLIC_SHARING
}
afterEach(() => flag(false))

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)
const json = (path: string, body: unknown, token?: string) => api('POST', path, { token, body: JSON.stringify(body) })

async function commit(top: string, files: Record<string, string>, attrs: object, token?: string) {
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  for (const e of entries) expect((await api('PUT', `/_blobs/${e.sha256}`, { token, body: e.body })).status).toBe(200)
  return json(`/_publish/${top}`, { files: entries.map(({ path, sha256 }) => ({ path, sha256 })), ...attrs }, token)
}

// a browser of `email` (null: no session) on a host
async function browser(email: string | null, origin: string) {
  const cookie = !email ? ''
    : origin === CONTENT ? `${COOKIE.content}=${await signEmail(env, email, 3600, CONTENT_TAG)}`
    : origin === APP ? `${COOKIE.app}=${await signEmail(env, email, 3600)}`
    : `${COOKIE.combined}=${await signEmail(env, email, 3600)}`
  return (path: string, init: RequestInit = {}) => fetchWorker(path, {
    ...init, headers: { ...NAV, ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) },
  }, origin)
}

// status, location and body, with the slug replaced, to compare the
// answer for a private share with the answer for a missing slug. The
// Google login keeps the return path base64 encoded in `state`.
async function answer(r: Response, top: string) {
  const norm = (s: string | null) => s?.replaceAll(top, 'SLUG') ?? null
  let location = r.headers.get('location')
  if (location?.startsWith('https://accounts.google.com/')) {
    const u = new URL(location)
    u.searchParams.set('state', atob(u.searchParams.get('state')!))
    location = u.toString()
  }
  return { status: r.status, location: norm(location), body: norm(await r.text()) }
}

// the not-found page of share paths (status 200, as before)
const NOT_FOUND = '<h1>404</h1>'

const FILES = { 'index.md': '# Hidden zebracorn', 'sub/a.md': 'a', 'sub/b.md': 'b' }

let priv: string // PAT's private share, two versions
let missing: string // a slug without a share
let col: string
let patToken: string, samToken: string

beforeAll(async () => {
  patToken = await userToken(PAT)
  samToken = await userToken(SAM)
  col = slug('vis-col')
  priv = slug('vis-priv')
  missing = slug('vis-missing')
  expect((await commit(priv, FILES, { collection: col, visibility: 'private', title: 'Zebracorn' }, patToken)).status).toBe(200)
  expect((await commit(priv, { ...FILES, 'index.md': '# Hidden zebracorn 2' }, {}, patToken)).status).toBe(200)
})

// the same request for the private share and for the missing slug: the
// answers must be equal
async function sameAsMissing(send: (top: string) => Promise<Response>) {
  const a = await answer(await send(priv), priv)
  const b = await answer(await send(missing), missing)
  expect(a).toEqual(b)
  return a
}

const CONTENT_PATHS = (s: string) => [
  `/${s}/`, `/${s}/index.md`, `/${s}`, `/${s}/sub`, `/${s}/sub/`, `/${s}@1/`, `/${s}@1/index.md`,
  `/${s}/_peek`, `/${s}/_peek?full`, `/${s}/_zip`,
]

describe('content reads of a private share', () => {
  for (const origin of [CONTENT, ORIGIN]) {
    const host = origin === CONTENT ? 'content host' : 'combined host'

    it(`serves every path to the owner on the ${host}`, async () => {
      const b = await browser(PAT, origin)
      for (const p of CONTENT_PATHS(priv)) {
        const r = await b(p)
        expect([200, 302], p).toContain(r.status)
      }
      expect(await (await b(`/${priv}/index.md`)).text()).toContain('Hidden zebracorn 2')
    })

    for (const who of [SAM, ADMIN]) {
      it(`answers ${who === ADMIN ? 'admin' : 'another member'} on the ${host} as for a missing slug`, async () => {
        const b = await browser(who, origin)
        for (let i = 0; i < CONTENT_PATHS('x').length; i++) {
          const a = await sameAsMissing((top) => b(CONTENT_PATHS(top)[i]))
          expect(a.body, CONTENT_PATHS(priv)[i]).toContain(NOT_FOUND)
        }
      })
    }

    for (const on of [false, true]) {
      it(`sends an anonymous reader on the ${host} to login with PUBLIC_SHARING ${on ? 'on' : 'off'}`, async () => {
        flag(on)
        const b = await browser(null, origin)
        for (let i = 0; i < CONTENT_PATHS('x').length; i++) {
          const a = await sameAsMissing((top) => b(CONTENT_PATHS(top)[i]))
          expect(a.status).toBe(302)
        }
      })
    }
  }

  it('answers _peek on the app host for another member as for a missing slug', async () => {
    const b = await browser(SAM, APP)
    const a = await sameAsMissing((top) => b(`/${top}/_peek`, { headers: { 'sec-fetch-site': 'same-origin' } }))
    expect(a.body).toContain(NOT_FOUND)
    const own = await (await browser(PAT, APP))(`/${priv}/_peek`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(own.status).toBe(200)
  })
})

describe('share page of a private share', () => {
  for (const origin of [APP, ORIGIN]) {
    it(`answers others on the ${origin === APP ? 'app' : 'combined'} host as for a missing slug`, async () => {
      for (const who of [SAM, ADMIN]) {
        const b = await browser(who, origin)
        for (const q of ['', '?v=1', '?v=1&f=index.md', '?diff=1..2']) {
          expect((await sameAsMissing((top) => b(`/_s/${top}${q}`))).status).toBe(404)
        }
        const post = (top: string) => b(`/_s/${top}`, {
          method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'action=title&title=x',
        })
        expect((await sameAsMissing(post)).status).toBe(404)
      }
      const own = await browser(PAT, origin)
      expect((await own(`/_s/${priv}?diff=1..2`)).status).toBe(200)
      expect(await (await own(`/_s/${priv}?v=1&f=index.md`)).text()).toContain('Hidden zebracorn')
    })
  }
})

describe('bearer reads of a private share', () => {
  it('answers another member and admin as for a missing slug', async () => {
    for (const token of [samToken, undefined]) {
      for (const p of ['/SLUG/index.md', '/SLUG@1/index.md', '/_list?prefix=SLUG/', '/SLUG/_views',
        '/_api/shares/SLUG', '/_api/shares/SLUG/versions', '/_api/shares/SLUG/manifest', '/_api/shares/SLUG/manifest?version=1']) {
        await sameAsMissing((top) => api('GET', p.replace('SLUG', top), { token }))
      }
      expect((await sameAsMissing((top) => json(`/_api/shares/${top}`, { title: 'x' }, token))).status).toBe(404)
    }
  })

  it('serves the owner', async () => {
    expect(await (await api('GET', `/${priv}@1/index.md`, { token: patToken })).text()).toBe('# Hidden zebracorn')
    expect(await (await api('GET', `/_list?prefix=${priv}/`, { token: patToken })).text()).toContain(`${priv}/sub/a.md`)
    expect((await api('GET', `/${priv}/_views`, { token: patToken })).status).toBe(200)
    const s = await (await api('GET', `/_api/shares/${priv}`, { token: patToken })).json<ShareInfo>()
    expect(s.visibility).toBe('private')
  })
})

describe('lists leave out private shares of others', () => {
  it('JSON lists and collection counts', async () => {
    const listed = async (q: string, token?: string) =>
      (await (await api('GET', `/_api/shares?${q}`, { token })).json<ShareInfo[]>()).map((s) => s.slug)
    expect(await listed(`collection=${col}`, patToken)).toEqual([priv])
    expect(await listed(`collection=${col}`, samToken)).toEqual([])
    expect(await listed(`collection=${col}`)).toEqual([])
    expect(await listed(`owner=${PAT}`)).not.toContain(priv)
    expect(await listed('limit=1000')).not.toContain(priv)

    // a public share of SAM makes col readable by everyone; PAT's private
    // share stays out of the count of others
    const open = slug('vis-open')
    expect((await commit(open, { 'x.md': 'x' }, { collection: col }, samToken)).status).toBe(200)
    const count = async (token?: string) => {
      const all = await (await api('GET', `/_api/collections?prefix=${col}`, { token })).json<Collection[]>()
      const one = await (await api('GET', `/_api/collections/${col}`, { token })).json<Collection>()
      expect(all.map((c) => c.shares)).toEqual([one.shares])
      return one.shares
    }
    expect(await count(patToken)).toBe(2)
    expect(await count(samToken)).toBe(1)
    expect(await count()).toBe(1)
    await api('DELETE', `/${open}/`, { token: samToken })
  })

  it('admin bare _list lists it for its owner only', async () => {
    expect(await (await api('GET', '/_list')).text()).not.toContain(priv)
    expect((await (await api('GET', '/_list', { token: patToken })).text()).split('\n')).toContain(priv)
  })

  it('web lists: /, /?q= and /?c=', async () => {
    for (const [who, sees] of [[PAT, true], [SAM, false], [ADMIN, false]] as const) {
      const b = await browser(who, ORIGIN)
      for (const p of ['/', '/?q=zebracorn', `/?c=${col}`]) {
        expect((await (await b(p)).text()).includes(`/${priv}/`), `${who} ${p}`).toBe(sees)
      }
    }
  })
})

describe('private collections', () => {
  // `pc` holds only PAT's private share `p1`
  let pc: string, p1: string, nocol: string
  beforeAll(async () => {
    pc = slug('pcol')
    p1 = slug('pcol-share')
    nocol = slug('pcol-missing')
    expect((await commit(p1, { 'x.md': 'x' }, { collection: pc, visibility: 'private' }, patToken)).status).toBe(200)
  })

  const getCol = async (c: string, token?: string) => {
    const r = await api('GET', `/_api/collections/${c}`, { token })
    return { status: r.status, body: await r.json<any>() }
  }
  const listCols = async (prefix: string, token?: string) =>
    (await (await api('GET', `/_api/collections?prefix=${prefix}`, { token })).json<Collection[]>()).map((c) => c.slug)

  it('answers others, admin included, as for a missing collection', async () => {
    for (const [who, token] of [[SAM, samToken], [ADMIN, undefined]] as const) {
      const b = await browser(who, ORIGIN)
      const a = await answer(await b(`/?c=${pc}`), pc)
      expect(a).toEqual(await answer(await b(`/?c=${nocol}`), nocol))
      expect(a.body).toContain(NOT_FOUND)
      expect(await getCol(pc, token)).toEqual(await getCol(nocol, token))
      expect((await getCol(pc, token)).status).toBe(404)
      expect(await listCols(pc, token)).toEqual([])
      expect(await (await b('/?view=collections')).text()).not.toContain(pc)
    }
  })

  it('is left out of the move picker of others', async () => {
    const own = slug('pcol-sam')
    expect((await commit(own, { 'x.md': 'x' }, {}, samToken)).status).toBe(200)
    const html = await (await (await browser(SAM, ORIGIN))(`/_s/${own}`)).text()
    expect(html).toContain('class="pick"')
    expect(html).not.toContain(pc)
    expect(await (await (await browser(PAT, ORIGIN))(`/_s/${p1}`)).text()).toContain(`value="${pc}"`)
  })

  it('is readable by its owner', async () => {
    expect((await (await (await browser(PAT, ORIGIN))(`/?c=${pc}`)).text())).toContain(`/${p1}/`)
    expect((await getCol(pc, patToken)).body).toMatchObject({ slug: pc, owner: PAT, shares: 1 })
    expect(await listCols(pc, patToken)).toEqual([pc])
  })

  it('refuses a collection update by others without its owner', async () => {
    for (const token of [samToken, undefined]) {
      const r = await api('PUT', `/_api/collections/${pc}`, { token, body: JSON.stringify({ title: 'taken' }) })
      expect(r.status).toBe(403)
      expect(await r.text()).not.toContain(PAT)
    }
    expect((await getCol(pc, patToken)).body.title).toBe(null)
  })

  it('takes a publish by slug from others and shows the collection to the owner of a share in it', async () => {
    const pc2 = slug('pcol2')
    expect((await commit(slug('pcol2-pat'), { 'x.md': 'x' }, { collection: pc2, visibility: 'private' }, patToken)).status).toBe(200)
    const theirs = slug('pcol2-sam')
    expect((await commit(theirs, { 'x.md': 'x' }, { collection: pc2, visibility: 'private' }, samToken)).status).toBe(200)
    expect((await getCol(pc2, samToken)).body).toMatchObject({ slug: pc2, owner: PAT, shares: 1 })
    expect(await listCols(pc2, samToken)).toEqual([pc2])
    const page = await (await (await browser(SAM, ORIGIN))(`/?c=${pc2}`)).text()
    expect(page).toContain(`/${theirs}/`)
    expect((await getCol(pc2)).status).toBe(404)
  })

  it('turns readable by others when one of its shares turns org', async () => {
    const pc3 = slug('pcol3')
    const p3 = slug('pcol3-share')
    expect((await commit(p3, { 'x.md': 'x' }, { collection: pc3, visibility: 'private' }, patToken)).status).toBe(200)
    expect((await getCol(pc3, samToken)).status).toBe(404)
    expect((await json(`/_api/shares/${p3}`, { visibility: 'org' }, patToken)).status).toBe(200)
    expect((await getCol(pc3, samToken)).body).toMatchObject({ slug: pc3, owner: PAT, shares: 1 })
    expect(await listCols(pc3, samToken)).toEqual([pc3])
    expect(await (await (await browser(SAM, ORIGIN))(`/?c=${pc3}`)).text()).toContain(`/${p3}/`)
  })

  it('an empty collection is readable by its owner only', async () => {
    const empty = slug('pcol-empty')
    expect((await api('PUT', `/_api/collections/${empty}`, { token: patToken, body: JSON.stringify({ title: 'Empty' }) })).status).toBe(200)
    expect((await getCol(empty, patToken)).body).toMatchObject({ slug: empty, owner: PAT, shares: 0 })
    expect(await listCols(empty, patToken)).toEqual([empty])
    for (const token of [samToken, undefined]) {
      expect((await getCol(empty, token)).status).toBe(404)
      expect(await listCols(empty, token)).toEqual([])
    }
  })

  it('an agent collection with org shares is readable by every member', async () => {
    const mr = `metareview/${slug('pr')}`
    const r = await json('/_api/tokens', { name: 'pcol-agent', scopes: ['write:metareview/*'] })
    const agent = (await r.json<ServiceTokenCreated>()).token
    const run = slug('pcol-run')
    expect((await commit(run, { 'index.md': '# run' }, { collection: mr }, agent)).status).toBe(200)
    for (const token of [samToken, patToken, undefined, agent]) {
      expect((await getCol(mr, token)).body).toMatchObject({ slug: mr, shares: 1 })
      expect(await listCols(mr, token)).toEqual([mr])
    }
    expect(await (await (await browser(SAM, ORIGIN))(`/?c=${mr}`)).text()).toContain(`/${run}/`)
  })
})

describe('setting the visibility', () => {
  it('a private publish is unreadable by others right after the commit, both publish flows', async () => {
    const a = slug('vis-new')
    expect((await commit(a, { 'x.md': 'x' }, { visibility: 'private' }, patToken)).status).toBe(200)
    expect((await api('GET', `/${a}/x.md`, { token: samToken })).status).toBe(404)

    const b = slug('vis-legacy')
    expect((await api('PUT', `/${b}/x.md`, { token: patToken, body: 'x' })).status).toBe(200)
    expect((await api('POST', `/_finalize/${b}?visibility=private`, { token: patToken, body: 'x.md' })).status).toBe(200)
    expect((await api('GET', `/${b}/x.md`, { token: samToken })).status).toBe(404)
    expect((await api('GET', `/${b}/x.md`, { token: patToken })).status).toBe(200)
  })

  it('a republish without visibility keeps it; rename and transfer keep it', async () => {
    const a = slug('vis-keep')
    await commit(a, { 'x.md': '1' }, { visibility: 'private' }, patToken)
    await commit(a, { 'x.md': '2' }, {}, patToken)
    expect((await api('GET', `/${a}/x.md`, { token: samToken })).status).toBe(404)

    const b = await browser(PAT, ORIGIN)
    const form = (body: string) => b(`/_s/${a}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body,
    })
    const to = `${a}-renamed`
    expect((await form(`action=rename&to=${to}`)).status).toBe(303)
    expect((await api('GET', `/${to}/x.md`, { token: samToken })).status).toBe(404)
    expect((await api('GET', `/${to}/x.md`, { token: patToken })).status).toBe(200)

    expect((await b(`/_s/${to}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: `action=transfer&to=${encodeURIComponent(SAM)}`,
    })).status).toBe(303)
    const s = await (await api('GET', `/_api/shares/${to}`, { token: samToken })).json<ShareInfo>()
    expect(s).toMatchObject({ owner: SAM, visibility: 'private' })
    expect((await api('GET', `/${to}/x.md`, { token: patToken })).status).toBe(404)
  })

  it('/_public off leaves a private share private and makes a public share org', async () => {
    const a = slug('vis-off')
    await commit(a, { 'x.md': 'x' }, { visibility: 'private' }, patToken)
    expect(await (await api('POST', `/_public/${a}`, { token: patToken, body: 'off' })).text()).toBe('off\n')
    expect((await api('GET', `/_api/shares/${a}`, { token: patToken })).ok).toBe(true)
    expect((await api('GET', `/${a}/x.md`, { token: samToken })).status).toBe(404)

    flag(true)
    expect(await (await api('POST', `/_public/${a}`, { token: patToken, body: 'on' })).text()).toBe('on\n')
    expect((await api('POST', `/_public/${a}`, { body: 'off' })).status).toBe(200)
    const s = await (await api('GET', `/_api/shares/${a}`, { token: patToken })).json<ShareInfo>()
    expect(s.visibility).toBe('org')
  })

  it('POST /_api/shares/<slug>: the owner sets any value, admin only public to org', async () => {
    const a = slug('vis-api')
    await commit(a, { 'x.md': 'x' }, {}, patToken)
    const set = (visibility: string, token?: string) => json(`/_api/shares/${a}`, { visibility }, token)
    expect((await set('public', patToken)).status).toBe(403)
    expect((await set('nobody', patToken)).status).toBe(400)
    expect((await set('private', undefined)).status).toBe(403)
    flag(true)
    expect((await set('public', undefined)).status).toBe(403)
    expect((await (await set('public', patToken)).json<ShareInfo>()).visibility).toBe('public')
    expect((await (await set('org', undefined)).json<ShareInfo>()).visibility).toBe('org')
    expect((await (await set('private', patToken)).json<ShareInfo>()).visibility).toBe('private')
    expect((await set('org', undefined)).status).toBe(404)

    const audit = (await (await api('GET', '/_audit?limit=1000')).text()).split('\n')
      .filter((l) => l.endsWith(`\t${a}`)).map((l) => l.split('\t')[2])
    expect(audit).toEqual(['visibility.private', 'visibility.org', 'visibility.public'])
  })

  it('a public share reads as org while PUBLIC_SHARING is off, and opens without login while on', async () => {
    flag(true)
    const a = slug('vis-pub')
    await commit(a, { 'index.md': '# Open' }, { visibility: 'public' }, patToken)
    const anon = await browser(null, CONTENT)
    expect((await anon(`/${a}/`)).status).toBe(200)
    flag(false)
    expect((await anon(`/${a}/`)).status).toBe(302)
    expect((await (await browser(SAM, CONTENT))(`/${a}/`)).status).toBe(200)
  })

  it('write refusals on a private share of another owner do not show the owner; admin can delete it', async () => {
    const a = slug('vis-write')
    await commit(a, { 'x.md': 'x' }, { visibility: 'private' }, patToken)
    for (const token of [samToken, undefined]) {
      for (const r of [
        await commit(a, { 'x.md': 'y' }, {}, token),
        await api('PUT', `/${a}/y.md`, { token, body: 'y' }),
        await api('POST', `/_finalize/${a}`, { token, body: 'x.md' }),
        await api('POST', `/_public/${a}`, { token, body: 'off' }),
      ]) {
        expect(r.status).toBe(403)
        expect(await r.text()).toBe('owned by another user\n')
      }
    }
    expect((await api('DELETE', `/${a}/`, { token: samToken })).status).toBe(403)
    expect(await (await api('DELETE', `/${a}/`)).text()).toBe('deleted 1\n')
  })

  it('migration 0005 makes shares with public = 1 public', async () => {
    const a = slug('vis-mig')
    await commit(a, { 'x.md': 'x' }, {}, patToken)
    await env.DB.prepare("UPDATE shares SET public = 1, visibility = 'org' WHERE slug = ?").bind(a).run()
    const mig = (env.TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) => m.name.startsWith('0005_'))!
    for (const q of mig.queries.filter((q) => /^\s*UPDATE/i.test(q))) await env.DB.prepare(q).run()
    const s = await (await api('GET', `/_api/shares/${a}`, { token: patToken })).json<ShareInfo>()
    expect(s.visibility).toBe('public')
  })
})

describe('service tokens and private shares', () => {
  let agent: string
  let svcCol: string
  beforeAll(async () => {
    svcCol = `svc/${slug('c')}`
    const r = await json('/_api/tokens', { name: 'vis-agent', scopes: ['write:svc/*'] })
    agent = (await r.json<ServiceTokenCreated>()).token
  })

  it('reads its own private shares and never the private share of a person', async () => {
    const own = slug('svc-own')
    expect((await commit(own, { 'x.md': 'x' }, { collection: svcCol, visibility: 'private' }, agent)).status).toBe(200)
    expect(await (await api('GET', `/${own}/x.md`, { token: agent })).text()).toBe('x')
    expect((await api('GET', `/${own}/x.md`, { token: samToken })).status).toBe(404)

    const person = slug('svc-person')
    await commit(person, { 'x.md': 'x' }, { collection: svcCol, visibility: 'private' }, patToken)
    const listed = await (await api('GET', `/_api/shares?collection=${svcCol}`, { token: agent })).json<ShareInfo[]>()
    expect(listed.map((s) => s.slug)).toEqual([own])
    const collection = await (await api('GET', `/_api/collections/${svcCol}`, { token: agent })).json<Collection>()
    expect(collection.shares).toBe(1)

    const nope = slug('svc-nope')
    for (const p of ['/SLUG/x.md', '/SLUG@1/x.md', '/_list?prefix=SLUG/', '/_api/shares/SLUG', '/_api/shares/SLUG/versions']) {
      const a = await answer(await api('GET', p.replace('SLUG', person), { token: agent }), person)
      const b = await answer(await api('GET', p.replace('SLUG', nope), { token: agent }), nope)
      expect(a, p).toEqual(b)
    }
    const r = await commit(person, { 'x.md': 'y' }, {}, agent)
    expect(r.status).toBe(404)
    expect(await r.text()).not.toContain(PAT)
    expect((await api('DELETE', `/${person}/`, { token: agent })).status).toBe(403)
  })

  it('sets private or org, never public', async () => {
    flag(true)
    const a = slug('svc-vis')
    expect((await commit(a, { 'x.md': 'x' }, { collection: svcCol, visibility: 'public' }, agent)).status).toBe(403)
    expect((await commit(a, { 'x.md': 'x' }, { collection: svcCol, visibility: 'org' }, agent)).status).toBe(200)
    expect((await json(`/_api/shares/${a}`, { visibility: 'public' }, agent)).status).toBe(403)
    const s = await (await json(`/_api/shares/${a}`, { visibility: 'private' }, agent)).json<ShareInfo>()
    expect(s.visibility).toBe('private')
  })
})
