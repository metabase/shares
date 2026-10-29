import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ServiceTokenCreated, ServiceTokenInfo, ShareInfo, VersionInfo } from '../src/api-types'
import { allows } from '../src/api/service'
import { sha256Hex } from '../src/store/d1r2'
import { ADMIN, api, publish, slug, userToken } from './helpers'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

const post = (path: string, body: unknown, token?: string, method = 'POST') =>
  api(method, path, { token, body: JSON.stringify(body) })

// the versioned publish sequence with share attributes
async function commit(top: string, files: Record<string, string>, attrs: object, token: string) {
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  const missing = await (await api('POST', '/_blobs/missing', { token, body: entries.map((e) => e.sha256).join('\n') })).text()
  for (const e of entries.filter((e) => missing.includes(e.sha256))) {
    expect((await api('PUT', `/_blobs/${e.sha256}`, { token, body: e.body })).status).toBe(200)
  }
  return post(`/_publish/${top}`, { files: entries.map(({ path, sha256 }) => ({ path, sha256 })), ...attrs }, token)
}

async function serviceToken(body: object, admin?: string) {
  const r = await post('/_api/tokens', body, admin)
  expect(r.status).toBe(200)
  return r.json<ServiceTokenCreated>()
}

describe('scope matching', () => {
  it('matches a trailing * as a prefix and lets write imply read', () => {
    expect(allows(['write:metareview/*'], 'write', 'metareview/pr-1')).toBe(true)
    expect(allows(['write:metareview/*'], 'read', 'metareview/pr-1')).toBe(true)
    expect(allows(['write:metareview/*'], 'write', 'metareview')).toBe(false)
    expect(allows(['write:metareview/*'], 'write', 'metareviewx/a')).toBe(false)
    expect(allows(['read:metareview/*'], 'write', 'metareview/pr-1')).toBe(false)
    expect(allows(['write:ci'], 'write', 'ci')).toBe(true)
    expect(allows(['write:*'], 'write', null)).toBe(false)
  })
})

describe('service tokens', () => {
  it('writes in its scope as the agent and is refused outside it', async () => {
    const { token } = await serviceToken({ name: 'metareview', scopes: ['write:metareview/*'] })
    const col = `metareview/${slug('pr')}`
    const top = slug('run')
    const r = await commit(top, { 'index.md': '# run' }, { collection: col, title: 'Run', meta: { pr: 1 } }, token)
    expect(r.status).toBe(200)

    const share = await (await api('GET', `/_api/shares/${top}`)).json<ShareInfo>()
    expect(share).toMatchObject({ owner: 'agent:metareview', collection: col, title: 'Run' })
    const [v] = await (await api('GET', `/_api/shares/${top}/versions`)).json<VersionInfo[]>()
    expect(v.createdBy).toBe('agent:metareview')

    // a second publish to the same share, and reads back
    expect((await commit(top, { 'index.md': '# run 2' }, {}, token)).status).toBe(200)
    expect(await (await api('GET', `/${top}/index.md`, { token })).text()).toBe('# run 2')
    expect(await (await api('GET', `/_list?prefix=${top}/`, { token })).text()).toBe(`${top}/index.md\n`)
    const listed = await (await api('GET', `/_api/shares?collection=${col}`, { token })).json<ShareInfo[]>()
    expect(listed.map((s) => s.slug)).toEqual([top])

    // outside its scope
    expect((await commit(slug('x'), { 'a.txt': 'a' }, { collection: 'other/x' }, token)).status).toBe(403)
    expect((await commit(slug('x'), { 'a.txt': 'a' }, {}, token)).status).toBe(403)
    expect((await commit(top, { 'a.txt': 'a' }, { collection: 'other/x' }, token)).status).toBe(403)
    expect((await post(`/_api/shares/${top}`, { collection: 'other/x' }, token)).status).toBe(403)
    expect((await api('GET', `/_api/shares?collection=other/x`, { token })).status).toBe(403)
    expect((await post('/_api/collections/other/x', { title: 'no' }, token, 'PUT')).status).toBe(403)
    expect((await api('DELETE', `/${top}/`, { token })).status).toBe(200)
    expect((await api('GET', `/_api/shares/${top}`)).status).toBe(404)
  })

  it('cannot touch shares outside its collections or use user routes', async () => {
    const { token } = await serviceToken({ name: 'ci', scopes: ['write:ci/*'] })
    const ann = await userToken('ann@metabase.com')
    const mine = slug('mine')
    expect((await publish(mine, { 'a.txt': 'secret' }, ann)).status).toBe(200)

    expect((await commit(mine, { 'a.txt': 'x' }, { collection: 'ci/a' }, token)).status).toBe(403)
    expect((await api('GET', `/${mine}/a.txt`, { token })).status).toBe(403)
    expect((await api('GET', `/_list?prefix=${mine}/`, { token })).status).toBe(403)
    expect((await api('DELETE', `/${mine}/`, { token })).status).toBe(403)
    expect((await api('PUT', `/${slug('legacy')}/a.txt`, { token, body: 'a' })).status).toBe(403)
    for (const path of ['/_list', '/_audit', '/_api/tokens', `/${mine}/_views`, '/_api/shares']) {
      expect((await api('GET', path, { token })).status, path).toBe(403)
    }
    expect((await api('POST', `/_public/${mine}`, { token, body: 'off' })).status).toBe(403)
    expect((await post('/_api/tokens', { name: 'evil', scopes: ['write:*'] }, token)).status).toBe(403)
    expect(await (await api('GET', `/${mine}/a.txt`, { token: ann })).text()).toBe('secret')
  })

  it('makes shares owned by on_behalf_of and lists only collections in scope', async () => {
    const { token } = await serviceToken({ name: 'bot', scopes: ['write:bot/*', 'read:shared'], on_behalf_of: 'pat@metabase.com' })
    const top = slug('run')
    expect((await commit(top, { 'a.txt': 'a' }, { collection: 'bot/one' }, token)).status).toBe(200)
    const share = await (await api('GET', `/_api/shares/${top}`)).json<ShareInfo>()
    expect(share.owner).toBe('pat@metabase.com')
    // the person owns it like any of their shares
    expect((await post(`/_api/shares/${top}`, { title: 'mine' }, await userToken('pat@metabase.com'))).status).toBe(200)

    await post('/_api/collections/shared', { title: 's' }, undefined, 'PUT')
    await post('/_api/collections/other', { title: 'o' }, undefined, 'PUT')
    const cols = await (await api('GET', '/_api/collections', { token })).json<{ slug: string }[]>()
    expect(cols.map((c) => c.slug).sort()).toEqual(['bot/one', 'shared'])
    expect((await commit(slug('r'), { 'a.txt': 'a' }, { collection: 'shared' }, token)).status).toBe(403)
  })

  it('is made, listed and revoked only by the admin, with audit rows', async () => {
    const bob = await userToken('bob@metabase.com')
    expect((await post('/_api/tokens', { name: 'x', scopes: ['write:x'] }, bob)).status).toBe(403)
    expect((await api('GET', '/_api/tokens?kind=service', { token: bob })).status).toBe(403)
    for (const bad of [
      { name: 'Bad Name', scopes: ['write:x'] },
      { name: 'ok', scopes: [] },
      { name: 'ok', scopes: ['admin:x'] },
      { name: 'ok', scopes: ['write:x'], on_behalf_of: 'eve@example.com' },
      { name: 'ok', scopes: ['write:x'], expires_days: 9999 },
    ]) expect((await post('/_api/tokens', bad)).status, JSON.stringify(bad)).toBe(400)

    const { id, token } = await serviceToken({ name: 'rev', scopes: ['write:rev/*'], expires_days: 30 })
    const all = await (await api('GET', '/_api/tokens?kind=service')).json<ServiceTokenInfo[]>()
    const info = all.find((t) => t.id === id)!
    expect(info).toMatchObject({ name: 'rev', scopes: ['write:rev/*'], created_by: ADMIN, on_behalf_of: null })
    expect(info.expires_at! - info.created_at).toBe(30 * 86400_000)
    expect(JSON.stringify(all)).not.toContain(token)

    expect((await api('DELETE', `/_api/tokens/${id}?kind=service`, { token: bob })).status).toBe(404)
    expect((await api('DELETE', `/_api/tokens/${id}?kind=service`)).status).toBe(200)
    expect((await api('GET', '/_api/collections', { token })).status).toBe(401)
    const { results } = await env.DB.prepare(`SELECT action, detail FROM audit WHERE detail LIKE ? ORDER BY id`)
      .bind(`%"id":"${id}"%`).all<{ action: string; detail: string }>()
    expect(results.map((r) => r.action)).toEqual(['token.create', 'token.revoke'])
    expect(JSON.parse(results[0].detail)).toMatchObject({ kind: 'service', scopes: '["write:rev/*"]' })
  })

  it('revokes itself with DELETE current', async () => {
    const { token } = await serviceToken({ name: 'self', scopes: ['read:x'] })
    expect((await api('DELETE', '/_api/tokens/current', { token })).status).toBe(200)
    expect((await api('GET', '/_api/collections', { token })).status).toBe(401)
  })

  it('does not appear in the token list of its admin', async () => {
    await serviceToken({ name: 'hidden', scopes: ['read:x'] }, await userToken(ADMIN))
    const mine = await (await api('GET', '/_api/tokens')).json<{ name: string }[]>()
    expect(mine.map((t) => t.name)).not.toContain('hidden')
  })
})
