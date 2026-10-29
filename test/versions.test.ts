import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PublishResponse, ServiceTokenCreated, ShareInfo, VersionInfo } from '../src/api-types'
import { COOKIE, CONTENT_TAG, signEmail } from '../src/auth'
import { sha256Hex } from '../src/store/d1r2'
import { APP, CONTENT, ORIGIN, api, browse, fetchWorker, publish, slug, userToken } from './helpers'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

// the versioned publish sequence, on `origin`
async function commit(top: string, files: Record<string, string>, attrs: object, token: string, origin = ORIGIN) {
  const call = (method: string, path: string, body: BodyInit) =>
    fetchWorker(path, { method, body, headers: { authorization: `Bearer ${token}` } }, origin)
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  const missing = await (await call('POST', '/_blobs/missing', entries.map((e) => e.sha256).join('\n'))).text()
  for (const e of entries.filter((e) => missing.includes(e.sha256))) {
    expect((await call('PUT', `/_blobs/${e.sha256}`, e.body)).status).toBe(200)
  }
  return call('POST', `/_publish/${top}`, JSON.stringify({ files: entries.map(({ path, sha256 }) => ({ path, sha256 })), ...attrs }))
}

async function metareviewToken() {
  const r = await api('POST', '/_api/tokens', { body: JSON.stringify({ name: 'metareview', scopes: ['write:metareview/*'] }) })
  expect(r.status).toBe(200)
  return (await r.json<ServiceTokenCreated>()).token
}

const run = (n: number) => ({
  'report.html': `<h1>run ${n}</h1>`,
  'run.json': JSON.stringify({ id: `r${n}` }),
  [`nodes/reviewer-${n}.html`]: `<p>node ${n}</p>`,
})

describe('version read paths', () => {
  it('reads each version of a share at <slug>@<n> after later publishes', async () => {
    const token = await metareviewToken()
    const col = `metareview/metabase-metabase/${slug('pr')}`
    const top = slug('mr')
    const r1 = await commit(top, run(1), { collection: col, message: 'r1 aaa', meta: { headSha: 'aaa' } }, token)
    expect(r1.status).toBe(200)
    expect(await r1.json<PublishResponse>()).toEqual({
      slug: top, version: 1, url: `${ORIGIN}/${top}/`, versionUrl: `${ORIGIN}/${top}@1/`,
    })
    expect((await commit(top, run(2), { message: 'r2 bbb', meta: { headSha: 'bbb' } }, token)).status).toBe(200)

    // bearer reads: service token and user token
    const ann = await userToken('ann@metabase.com')
    for (const t of [token, ann]) {
      expect(await (await api('GET', `/${top}@1/report.html`, { token: t })).text()).toBe('<h1>run 1</h1>')
      expect(await (await api('GET', `/${top}@2/report.html`, { token: t })).text()).toBe('<h1>run 2</h1>')
      expect(await (await api('GET', `/${top}/report.html`, { token: t })).text()).toBe('<h1>run 2</h1>')
      expect(await (await api('GET', `/_list?prefix=${top}@1/nodes/`, { token: t })).text())
        .toBe(`${top}@1/nodes/reviewer-1.html\n`)
    }
    expect((await api('GET', `/${top}@3/report.html`, { token })).status).toBe(404)
    expect((await api('GET', `/${top}@1/nodes/reviewer-2.html`, { token })).status).toBe(404)

    // browser: the version's listing links stay inside the version
    const list = await browse(`/${top}@1/`)
    expect(list.status).toBe(200)
    const html = await list.text()
    expect(html).toContain(`href="/${top}@1/nodes/reviewer-1.html"`)
    expect(html).not.toContain('reviewer-2')
    expect(await (await browse(`/${top}@1/report.html`)).text()).toContain('run 1')
    expect((await browse(`/${top}@1`)).headers.get('location')).toBe(`${ORIGIN}/${top}@1/`)
    expect(await (await browse(`/${top}@9/`)).text()).toContain('<h1>404</h1>')

    // a view of a version counts for its share
    const views = await (await api('GET', `/${top}/_views`)).text()
    expect(views).toMatch(new RegExp(`^${env.ADMIN_EMAIL}\t1\t`))

    // the API lists both versions with their messages
    const versions = await (await api('GET', `/_api/shares/${top}/versions`, { token })).json<VersionInfo[]>()
    expect(versions.map((v) => [v.version, v.message, v.live])).toEqual([[2, 'r2 bbb', true], [1, 'r1 aaa', false]])
  })

  it('refuses writes to <slug>@<n> and new slugs of that form', async () => {
    const token = await metareviewToken()
    const col = `metareview/${slug('pr')}`
    const top = slug('mr')
    expect((await commit(top, run(1), { collection: col }, token)).status).toBe(200)

    expect((await commit(`${top}@1`, run(2), { collection: col }, token)).status).toBe(400)
    expect((await api('DELETE', `/${top}@1/`, { token })).status).toBe(403)
    expect((await api('PUT', `/${top}@1/x.txt`, { body: 'x' })).status).toBe(400)
    expect((await api('DELETE', `/${top}@1/`)).status).toBe(400)
    expect((await api('POST', `/_finalize/${top}@1`, { body: 'x.txt' })).status).toBe(400)
    expect((await api('POST', `/_public/${top}@1`, { body: 'off' })).status).toBe(400)
    expect((await publish(`fresh-${top}@2`, { 'a.txt': 'a' })).status).toBe(400)

    // the share is unchanged
    const share = await (await api('GET', `/_api/shares/${top}`)).json<ShareInfo>()
    expect(share.version).toBe(1)
    expect(await (await api('GET', `/${top}/report.html`)).text()).toBe('<h1>run 1</h1>')
  })

  it('keeps a slug with "@" that is not followed by a version number', async () => {
    const top = `${slug('a')}@b`
    expect((await publish(top, { 'a.txt': 'a' })).status).toBe(200)
    expect(await (await api('GET', `/${top}/a.txt`)).text()).toBe('a')
  })

  it('gives content host links when the publish goes to the app host', async () => {
    const token = await metareviewToken()
    const top = slug('mr')
    const r = await commit(top, run(1), { collection: `metareview/${slug('pr')}` }, token, APP)
    expect(r.status).toBe(200)
    expect(await r.json<PublishResponse>()).toMatchObject({ url: `${CONTENT}/${top}/`, versionUrl: `${CONTENT}/${top}@1/` })

    const cookie = `${COOKIE.content}=${await signEmail(env, 'pat@metabase.com', 3600, CONTENT_TAG)}`
    const page = await fetchWorker(`/${top}@1/report.html`, {
      headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    }, CONTENT)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('run 1')
  })
})
