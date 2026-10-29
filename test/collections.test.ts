import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/store/d1r2'
import { ADMIN, api, publish, slug, userToken } from './helpers'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

// versioned publish with share attributes in the commit body
async function commit(top: string, files: Record<string, string>, attrs: object = {}, token?: string) {
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  for (const e of entries) await api('PUT', `/_blobs/${e.sha256}`, { token, body: e.body })
  return api('POST', `/_publish/${top}`, {
    token, body: JSON.stringify({ files: entries.map(({ path, sha256 }) => ({ path, sha256 })), ...attrs }),
  })
}

const json = async (path: string, token?: string) => {
  const r = await api('GET', path, { token })
  return { status: r.status, body: await r.json() as any }
}

const post = (path: string, body: object, token?: string, method = 'POST') =>
  api(method, path, { token, body: JSON.stringify(body) })

describe('collections and metadata', () => {
  it('publishes into a collection and lists it back as JSON', async () => {
    const col = `metareview/${slug('pr')}`
    const a = slug('run')
    const b = slug('run')
    expect((await commit(a, { 'index.md': '# a' }, { collection: col, title: 'Run A', meta: { pr: 85416, status: 'ok' } })).status).toBe(200)
    expect((await commit(b, { 'index.md': '# b' }, { collection: col, meta: { pr: 85416, status: 'failed' } })).status).toBe(200)

    const { status, body } = await json(`/_api/shares?collection=${encodeURIComponent(col)}`)
    expect(status).toBe(200)
    expect(body.map((s: any) => s.slug)).toEqual([b, a])
    expect(body[1]).toMatchObject({
      slug: a, title: 'Run A', owner: ADMIN, collection: col, meta: { pr: 85416, status: 'ok' }, version: 1, fileCount: 1,
    })

    const c = await json(`/_api/collections/${col}`)
    expect(c.body).toMatchObject({ slug: col, owner: ADMIN, shares: 2, meta: {} })
    expect((await json('/_api/collections?prefix=metareview/')).body.map((x: any) => x.slug)).toContain(col)
  })

  it('filters by meta, matching the JSON value or its string form', async () => {
    const col = slug('filter')
    const a = slug('m')
    const b = slug('m')
    await commit(a, { 'x.txt': 'a' }, { collection: col, meta: { pr: 1, status: 'ok' } })
    await commit(b, { 'x.txt': 'b' }, { collection: col, meta: { pr: '1', status: 'failed' } })
    const q = (s: string) => json(`/_api/shares?collection=${col}&${s}`).then((r) => r.body.map((x: any) => x.slug).sort())
    expect(await q('meta.pr=1')).toEqual([a, b].sort())
    expect(await q('meta.status=ok')).toEqual([a])
    expect(await q('meta.pr=1&meta.status=failed')).toEqual([b])
    expect(await q('meta.nope=x')).toEqual([])
  })

  it('pages with limit and before', async () => {
    const col = slug('page')
    for (const n of [1, 2, 3]) {
      await commit(slug(`p${n}`), { 'x.txt': `${col} ${n}` }, { collection: col })
      await new Promise((r) => setTimeout(r, 2))
    }
    const first = (await json(`/_api/shares?collection=${col}&limit=2`)).body
    expect(first).toHaveLength(2)
    const next = (await json(`/_api/shares?collection=${col}&limit=2&before=${first[1].updatedAt}`)).body
    expect(next).toHaveLength(1)
    expect((await json(`/_api/shares?collection=${col}&limit=0`)).status).toBe(400)
  })

  it('sets attributes through the legacy finalize query', async () => {
    const top = slug('leg')
    const col = slug('legcol')
    await api('PUT', `/${top}/a.txt`, { body: 'a' })
    const r = await api('POST', `/_finalize/${top}?collection=${col}&title=Legacy&meta=pr=7&meta=kind=review`, { body: 'a.txt' })
    expect(r.status).toBe(200)
    expect((await json(`/_api/shares/${top}`)).body).toMatchObject({ collection: col, title: 'Legacy', meta: { pr: '7', kind: 'review' } })
    expect((await api('POST', `/_finalize/${top}?meta=novalue`, { body: 'a.txt' })).status).toBe(400)
  })

  it('keeps attributes that a later publish omits, and removes null meta keys', async () => {
    const top = slug('keep')
    const col = slug('keepcol')
    await commit(top, { 'a.txt': 'a1' }, { collection: col, title: 'T', meta: { a: 1, b: 2 } })
    await commit(top, { 'a.txt': 'a2' }, { meta: { b: null, c: [1, 'x'] } })
    expect((await json(`/_api/shares/${top}`)).body).toMatchObject({ collection: col, title: 'T', meta: { a: 1, c: [1, 'x'] }, version: 2 })
    expect((await json(`/_api/shares/${top}`)).body.meta).not.toHaveProperty('b')
  })

  it('refuses bad attributes without making a version', async () => {
    const top = slug('bad')
    for (const attrs of [{ collection: 'Upper/Case' }, { collection: '/x' }, { meta: { 'bad key': 1 } }, { meta: [1] }, { title: 5 }]) {
      const r = await commit(top, { 'a.txt': 'a' }, attrs)
      expect(r.status).toBe(400)
    }
    expect((await json(`/_api/shares/${top}`)).status).toBe(404)
  })

  it('updates share attributes without a publish, owner only', async () => {
    const ann = await userToken('ann@metabase.com')
    const bob = await userToken('bob@metabase.com')
    const top = slug('attr')
    await commit(top, { 'a.txt': 'a' }, {}, ann)
    const r = await post(`/_api/shares/${top}`, { title: 'New', meta: { k: 'v' } }, ann)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ title: 'New', meta: { k: 'v' }, version: 1 })
    expect((await post(`/_api/shares/${top}`, { title: 'X' }, bob)).status).toBe(403)
    expect((await post(`/_api/shares/${top}`, { collection: null })).status).toBe(200)
  })

  it('creates and updates a collection, owner only', async () => {
    const ann = await userToken('ann@metabase.com')
    const bob = await userToken('bob@metabase.com')
    const col = `team/${slug('c')}`
    const r = await post(`/_api/collections/${col}`, { title: 'Reviews', meta: { repo: 'metabase/metabase' } }, ann, 'PUT')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ slug: col, title: 'Reviews', owner: 'ann@metabase.com', meta: { repo: 'metabase/metabase' }, shares: 0 })
    expect((await post(`/_api/collections/${col}`, { title: 'Mine' }, bob, 'PUT')).status).toBe(403)
    // anyone can publish into it
    expect((await commit(slug('in'), { 'a.txt': 'a' }, { collection: col }, bob)).status).toBe(200)
    const c = (await json(`/_api/collections/${col}`, bob)).body
    expect(c).toMatchObject({ owner: 'ann@metabase.com', title: 'Reviews', shares: 1 })
    expect((await post(`/_api/collections/${col}`, { meta: { x: null } }, ann, 'PUT')).status).toBe(400)
    expect((await json(`/_api/collections/${col}/nope`)).status).toBe(404)
  })

  it('lists shares outside a collection to their owner only', async () => {
    const ann = await userToken('ann@metabase.com')
    const carl = await userToken('carl@metabase.com')
    const top = slug('own')
    await commit(top, { 'a.txt': 'a' }, {}, carl)
    expect((await json('/_api/shares', carl)).body.map((s: any) => s.slug)).toContain(top)
    expect((await json('/_api/shares', ann)).body.map((s: any) => s.slug)).not.toContain(top)
    expect((await json('/_api/shares?owner=carl@metabase.com', ann)).status).toBe(403)
    expect((await json('/_api/shares?owner=carl@metabase.com')).body.map((s: any) => s.slug)).toContain(top)
  })

  it('lists versions and reads manifests', async () => {
    const top = slug('ver')
    await commit(top, { 'a.txt': 'one' })
    await commit(top, { 'a.txt': 'two', 'b/c.md': '# c' })
    await api('PUT', `/${top}/pending.txt`, { body: 'p' })

    const v = (await json(`/_api/shares/${top}/versions`)).body
    expect(v.map((x: any) => [x.version, x.state, x.live])).toEqual([[3, 'pending', false], [2, 'complete', true], [1, 'complete', false]])
    expect(v[1]).toMatchObject({ createdBy: ADMIN, fileCount: 2, totalBytes: 6 })

    const m = (await json(`/_api/shares/${top}/manifest`)).body
    expect(m).toEqual({
      slug: top, version: 2,
      files: [
        { path: 'a.txt', sha256: await sha('two'), size: 3, contentType: null },
        { path: 'b/c.md', sha256: await sha('# c'), size: 3, contentType: null },
      ],
    })
    expect((await json(`/_api/shares/${top}/manifest?version=1`)).body.files.map((f: any) => f.path)).toEqual(['a.txt'])
    expect((await json(`/_api/shares/${top}/manifest?version=3`)).status).toBe(404)
    expect((await json(`/_api/shares/${top}/manifest?version=x`)).status).toBe(400)
    expect((await json('/_api/shares/nope-none/versions')).status).toBe(404)
  })

  it('answers errors as JSON', async () => {
    const r = await api('GET', '/_api/nope')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'not found' })
    expect((await api('GET', '/_api/shares', { token: 'bad' })).status).toBe(403)
  })

  it('still publishes without attributes through the legacy flow', async () => {
    const top = slug('plain')
    expect((await publish(top, { 'a.txt': 'a' })).status).toBe(200)
    expect((await json(`/_api/shares/${top}`)).body).toMatchObject({ collection: null, title: null, meta: {} })
  })
})
