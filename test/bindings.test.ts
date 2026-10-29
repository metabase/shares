import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { hostKind } from '../src/hosts'

describe('D1 schema', () => {
  it('has the tables of the migrations', async () => {
    const { results } = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name")
      .all<{ name: string }>()
    expect(results.map((r) => r.name)).toEqual(
      ['audit', 'collections', 'device_codes', 'files', 'share_meta', 'shares', 'tokens', 'users', 'versions', 'views'])
  })

  it('stores a share with a version, files and metadata, and cascades deletes', async () => {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').bind('ann@metabase.com', now),
      env.DB.prepare('INSERT INTO collections (slug, owner, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .bind('runs', 'ann@metabase.com', now, now),
      env.DB.prepare('INSERT INTO shares (slug, owner, collection, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('s1', 'ann@metabase.com', 'runs', now, now),
      env.DB.prepare('INSERT INTO versions (share, version, created_by, created_at) VALUES (?, 1, ?, ?)')
        .bind('s1', 'ann@metabase.com', now),
      env.DB.prepare("INSERT INTO files (share, version, path, sha256, size) VALUES ('s1', 1, 'index.md', 'ab', 2)"),
      env.DB.prepare("INSERT INTO share_meta (share, key, value) VALUES ('s1', 'kind', '\"review\"')"),
      env.DB.prepare("INSERT INTO tokens (id, hash, name, owner, kind, created_at) VALUES ('t1', 'h1', 'ci', 'ann@metabase.com', 'service', ?)").bind(now),
    ])
    const share = await env.DB.prepare('SELECT public, current_version FROM shares WHERE slug = ?').bind('s1').first()
    expect(share).toEqual({ public: 0, current_version: null })

    await env.DB.prepare('DELETE FROM shares WHERE slug = ?').bind('s1').run()
    const left = await env.DB.prepare('SELECT (SELECT count(*) FROM files) AS f, (SELECT count(*) FROM share_meta) AS m').first()
    expect(left).toEqual({ f: 0, m: 0 })
  })

  it('rejects an unknown token kind', async () => {
    await env.DB.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').bind('bob@metabase.com', 1).run()
    await expect(env.DB
      .prepare("INSERT INTO tokens (id, hash, name, owner, kind, created_at) VALUES ('t2', 'h2', 'x', 'bob@metabase.com', 'robot', 1)")
      .run()).rejects.toThrow(/CHECK constraint/)
  })
})

describe('R2 binding', () => {
  it('stores and reads a blob', async () => {
    await env.BLOBS.put('blobs/abc', 'hello')
    expect(await (await env.BLOBS.get('blobs/abc'))!.text()).toBe('hello')
  })
})

describe('hosts', () => {
  const e = { ...env, CONTENT_HOST: 'shares.metabase.fyi', APP_HOST: 'app.shares.metabase.fyi' }
  it('classifies a request by its hostname', () => {
    expect(hostKind(new URL('https://shares.metabase.fyi/x/'), e)).toBe('content')
    expect(hostKind(new URL('https://app.shares.metabase.fyi/'), e)).toBe('app')
    expect(hostKind(new URL('https://mb-shares.escherize.workers.dev/'), e)).toBe('combined')
    expect(hostKind(new URL('https://shares.metabase.fyi/'), env)).toBe('combined')
  })
})
