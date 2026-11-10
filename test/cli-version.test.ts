import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { CACHE_KEY, latestCli, withCliHeaders } from '../src/cli-version'
import { handle } from '../src/routes'
import { ORIGIN } from './helpers'

const GH = { ...env, CLI_LATEST_URL: 'https://releases.test/latest' }

const redirect = (tag: string) => async () =>
  new Response(null, { status: 302, headers: { location: `https://github.com/metabase/shares/releases/tag/${tag}` } })

describe('x-share-cli-latest', () => {
  beforeEach(async () => { await caches.default.delete(CACHE_KEY) })

  it('reads the version from the latest-release redirect and caches it', async () => {
    const fetcher = vi.fn(redirect('cli-v0.3.1'))
    const a = await withCliHeaders(new Response('ok'), GH, undefined, fetcher)
    expect(a.headers.get('x-share-cli-latest')).toBe('0.3.1')
    expect(fetcher).toHaveBeenCalledWith('https://releases.test/latest', expect.objectContaining({ redirect: 'manual' }))

    const b = await withCliHeaders(new Response('ok'), GH, undefined, fetcher)
    expect(b.headers.get('x-share-cli-latest')).toBe('0.3.1')
    expect(await b.text()).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('omits the header when GitHub fails, and caches the miss', async () => {
    const fetcher = vi.fn(async (): Promise<Response> => { throw new Error('network down') })
    const r = await withCliHeaders(new Response('ok', { status: 201 }), GH, undefined, fetcher)
    expect(r.headers.has('x-share-cli-latest')).toBe(false)
    expect(r.status).toBe(201)
    expect(await latestCli(GH, undefined, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('omits the header for a redirect without a stable cli tag', async () => {
    for (const f of [redirect('cli-v0.4.0-rc.1'), redirect('v1.0.0'), async () => new Response('x', { status: 500 })]) {
      await caches.default.delete(CACHE_KEY)
      expect(await latestCli(GH, undefined, f)).toBeNull()
    }
  })

  it('makes no lookup when CLI_LATEST_URL is off', async () => {
    const fetcher = vi.fn(redirect('cli-v0.3.1'))
    expect(await latestCli({ ...env, CLI_LATEST_URL: 'off' }, undefined, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('x-share-cli-min', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('is on bearer API answers when CLI_MIN_VERSION is set, not on browser pages', async () => {
    const e = { ...env, CLI_MIN_VERSION: '0.3.0' }
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const authed = await handle(new Request(`${ORIGIN}/_list`, { headers: { authorization: `Bearer ${env.UPLOAD_TOKEN}` } }), e, ctx)
    expect(authed.status).toBe(200)
    expect(authed.headers.get('x-share-cli-min')).toBe('0.3.0')
    const anon = await handle(new Request(`${ORIGIN}/_list`, { headers: { authorization: 'Bearer nope' } }), e, ctx)
    expect(anon.status).toBe(401)
    expect(anon.headers.get('x-share-cli-min')).toBe('0.3.0')
    const page = await handle(new Request(`${ORIGIN}/`), e, ctx)
    expect(page.headers.has('x-share-cli-min')).toBe(false)
  })

  it('is absent without CLI_MIN_VERSION or with a malformed one', async () => {
    expect((await withCliHeaders(new Response('ok'), env, undefined)).headers.has('x-share-cli-min')).toBe(false)
    expect((await withCliHeaders(new Response('ok'), { ...env, CLI_MIN_VERSION: 'soon' }, undefined)).headers.has('x-share-cli-min')).toBe(false)
  })
})
