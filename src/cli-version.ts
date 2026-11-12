// Version headers on answers to the `share` CLI (bearer-token API):
//   x-share-cli-latest  the newest CLI release; the CLI shows an update notice
//   x-share-cli-min     var CLI_MIN_VERSION; an older CLI stops
//   x-share-skill       sha256 (hex) of skill/SKILL.md, as /_skill serves it;
//                       the CLI notes an installed skill that differs
// The latest version comes from the GitHub latest-release redirect
// (.../releases/latest -> .../releases/tag/cli-v<x.y.z>), kept in the Cache
// API for 15 minutes. When GitHub fails, the header is absent: a CLI request
// never fails because of it.

import type { Env } from './env'
import SKILL_MD from '../skill/SKILL.md' // text module (wrangler.toml rules)

export const LATEST_URL = 'https://github.com/metabase/shares/releases/latest'
// Cache API key; the host is never fetched
export const CACHE_KEY = 'https://cli-latest.cache.internal/v1'
const TTL = 15 * 60
const MISS_TTL = 60
const TIMEOUT_MS = 2000

const VERSION_RE = /^\d+\.\d+\.\d+$/

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

// the version in a latest-release redirect; null when there is none
export async function fetchLatest(url: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const res = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    await res.body?.cancel()
    const m = /\/tag\/cli-v([^/?#]+)$/.exec(res.headers.get('location') || '')
    return m && VERSION_RE.test(m[1]) ? m[1] : null
  } catch {
    return null
  }
}

// The latest CLI version, from the cache or GitHub. A miss is cached for a
// short time too, so GitHub trouble does not slow every request.
// CLI_LATEST_URL "off": no lookup (tests).
export async function latestCli(env: Env, ctx: ExecutionContext | undefined, fetcher: Fetcher = (i, o) => fetch(i, o)) {
  const url = env.CLI_LATEST_URL || LATEST_URL
  if (url === 'off') return null
  const cache = caches.default
  try {
    const hit = await cache.match(CACHE_KEY)
    if (hit) {
      const v = (await hit.text()).trim()
      return VERSION_RE.test(v) ? v : null
    }
  } catch { /* no cache: ask GitHub */ }
  const v = await fetchLatest(url, fetcher)
  const put = cache.put(CACHE_KEY, new Response(v ?? '', {
    headers: { 'cache-control': `max-age=${v ? TTL : MISS_TTL}` },
  })).catch(() => {})
  if (ctx) ctx.waitUntil(put)
  else await put
  return v
}

let skillSum: Promise<string> | undefined

// the sha256 (hex) of the served skill, computed once per isolate
export function skillHash(): Promise<string> {
  skillSum ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(SKILL_MD)).then((d) =>
    [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''))
  return skillSum
}

export async function skillResponse() {
  return new Response(SKILL_MD, { headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-share-skill': await skillHash() } })
}

export async function withCliHeaders(res: Response, env: Env, ctx: ExecutionContext | undefined, fetcher?: Fetcher) {
  const latest = await latestCli(env, ctx, fetcher)
  const min = env.CLI_MIN_VERSION && VERSION_RE.test(env.CLI_MIN_VERSION) ? env.CLI_MIN_VERSION : null
  // Response.redirect() has immutable headers
  const out = new Response(res.body, res)
  out.headers.set('x-share-skill', await skillHash())
  if (latest) out.headers.set('x-share-cli-latest', latest)
  if (min) out.headers.set('x-share-cli-min', min)
  return out
}
