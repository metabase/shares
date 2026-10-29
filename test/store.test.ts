import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/store/d1r2'
import { api, publish, slug, userToken } from './helpers'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

// the versioned publish sequence: missing check, blob uploads, one commit
async function commit(top: string, files: Record<string, string>, token?: string) {
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  const missing = await (await api('POST', '/_blobs/missing', { token, body: entries.map((e) => e.sha256).join('\n') })).text()
  for (const e of entries.filter((e) => missing.includes(e.sha256))) {
    expect((await api('PUT', `/_blobs/${e.sha256}`, { token, body: e.body })).status).toBe(200)
  }
  return api('POST', `/_publish/${top}`, {
    token, body: JSON.stringify({ files: entries.map(({ path, sha256 }) => ({ path, sha256 })) }),
  })
}

const text = async (path: string) => {
  const r = await api('GET', path)
  return r.status === 200 ? r.text() : r.status
}

const list = async (top: string) => (await api('GET', `/_list?prefix=${top}/`)).text()

describe('versioned publish', () => {
  it('publishes from blobs and a manifest', async () => {
    const top = slug('v')
    const r = await commit(top, { 'index.md': '# one', 'sub/a.txt': 'a' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ slug: top, version: 1 })
    expect(await list(top)).toBe(`${top}/index.md\n${top}/sub/a.txt\n`)
    expect(await text(`/${top}/sub/a.txt`)).toBe('a')
    expect(await (await api('GET', '/_list')).text()).toContain(`${top}\n`)
  })

  it('reports only the blobs the store lacks', async () => {
    const body = `dedupe ${Date.now()}`
    const h = await sha(body)
    expect(await (await api('POST', '/_blobs/missing', { body: h })).text()).toBe(`${h}\n`)
    await api('PUT', `/_blobs/${h}`, { body })
    expect(await (await api('POST', '/_blobs/missing', { body: h })).text()).toBe('')
  })

  it('refuses a blob whose body does not match its sha256', async () => {
    const r = await api('PUT', `/_blobs/${await sha('x')}`, { body: 'y' })
    expect(r.status).toBe(400)
  })

  it('replaces the files on overwrite and counts versions', async () => {
    const top = slug('ov')
    await commit(top, { 'old.txt': 'old', 'keep.txt': 'k1' })
    const r = await commit(top, { 'keep.txt': 'k2', 'new.txt': 'new' })
    expect(await r.json()).toMatchObject({ slug: top, version: 2 })
    expect(await list(top)).toBe(`${top}/keep.txt\n${top}/new.txt\n`)
    expect(await text(`/${top}/keep.txt`)).toBe('k2')
    expect(await text(`/${top}/old.txt`)).toBe(404)
  })

  it('keeps the previous version live when a blob is missing', async () => {
    const top = slug('miss')
    await commit(top, { 'a.txt': 'v1' })
    const r = await api('POST', `/_publish/${top}`, {
      body: JSON.stringify({ files: [{ path: 'a.txt', sha256: await sha(`never uploaded ${top}`) }] }),
    })
    expect(r.status).toBe(400)
    expect(await r.text()).toMatch(/^missing blobs: /)
    expect(await text(`/${top}/a.txt`)).toBe('v1')
    const v = await env.DB.prepare('SELECT count(*) AS n FROM versions WHERE share = ?').bind(top).first('n')
    expect(v).toBe(1)
  })

  it('rejects bad paths and slugs', async () => {
    const h = await sha('p')
    await api('PUT', `/_blobs/${h}`, { body: 'p' })
    for (const path of ['../x', '/abs', 'a//b', '']) {
      const r = await api('POST', `/_publish/${slug('bad')}`, { body: JSON.stringify({ files: [{ path, sha256: h }] }) })
      expect(r.status).toBe(400)
    }
    expect((await api('POST', '/_publish/_own', { body: JSON.stringify({ files: [] }) })).status).toBe(400)
  })

  it('refuses a publish to a share owned by another user', async () => {
    const top = slug('own')
    await commit(top, { 'a.txt': 'a' }, await userToken('ann@metabase.com'))
    const r = await commit(top, { 'a.txt': 'b' }, await userToken('bob@metabase.com'))
    expect(r.status).toBe(403)
    expect(await text(`/${top}/a.txt`)).toBe('a')
  })
})

describe('legacy publish (PUT, then finalize)', () => {
  it('overwrites without a delete: the old version is live until finalize', async () => {
    const top = slug('leg')
    await publish(top, { 'old.txt': 'old', 'keep.txt': 'k1' })
    expect((await api('PUT', `/${top}/keep.txt`, { body: 'k2' })).status).toBe(200)
    // upload in progress: readers still see version 1
    expect(await text(`/${top}/keep.txt`)).toBe('k1')
    expect(await text(`/${top}/old.txt`)).toBe('old')
    expect((await api('POST', `/_finalize/${top}`, { body: 'keep.txt' })).status).toBe(200)
    expect(await text(`/${top}/keep.txt`)).toBe('k2')
    expect(await text(`/${top}/old.txt`)).toBe(404)
    expect(await list(top)).toBe(`${top}/keep.txt\n`)
  })

  it('refuses a finalize that names a file not uploaded, and keeps the previous version', async () => {
    const top = slug('fail')
    await publish(top, { 'a.txt': 'v1', 'b.txt': 'v1' })
    await api('PUT', `/${top}/a.txt`, { body: 'v2' })
    const r = await api('POST', `/_finalize/${top}`, { body: 'a.txt\nb.txt' })
    expect(r.status).toBe(400)
    expect(await r.text()).toBe('not uploaded: b.txt\n')
    expect(await text(`/${top}/a.txt`)).toBe('v1')
    expect(await list(top)).toBe(`${top}/a.txt\n${top}/b.txt\n`)
  })

  it('refuses a finalize with no upload', async () => {
    expect((await api('POST', `/_finalize/${slug('none')}`, { body: 'a.txt' })).status).toBe(400)
  })
})

describe('delete', () => {
  it('removes the share and the blobs no other share uses', async () => {
    const a = slug('del')
    const b = slug('other')
    const only = `only in ${a}`
    const both = `in both ${a}`
    await commit(a, { 'x.txt': only, 'y.txt': both })
    await commit(b, { 'y.txt': both })
    expect(await (await api('DELETE', `/${a}/`)).text()).toBe('deleted 2\n')
    expect(await text(`/${a}/x.txt`)).toBe(404)
    expect(await env.BLOBS.head(`blobs/${await sha(only)}`)).toBeNull()
    expect(await env.BLOBS.head(`blobs/${await sha(both)}`)).not.toBeNull()
    expect(await text(`/${b}/y.txt`)).toBe(both)
    expect(await (await api('GET', '/_list')).text()).not.toContain(`${a}\n`)
  })
})
