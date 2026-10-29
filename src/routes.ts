import type { Env } from './env'
import { handleCallback, redirectToGoogle, sessionEmail, tokenEmail } from './auth'
import { cli } from './api/cli'
import { serve } from './web/serve'
import { storeFor } from './store'

export async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const store = storeFor(env)

  // CLI endpoints: bearer token, no cookies involved. Bearer GET serves
  // raw bytes (for `share download`); browsers never send one.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, '')
  if (req.method === 'PUT' || req.method === 'DELETE' || req.method === 'POST'
      || url.pathname === '/_list' || (req.method === 'GET' && bearer)) {
    const who = await tokenEmail(env, bearer)
    if (!who) return new Response('forbidden', { status: 403 })
    return cli(req, url, env, store, who)
  }

  if (url.pathname === '/auth/callback' && !env.PUBLIC) return handleCallback(url, env)

  // PUBLIC (pubshare deploy): anonymous read-only viewers, no login.
  // Writes still go through the bearer-token branch above.
  const email = env.PUBLIC ? null : await sessionEmail(req, env)
  if (!email && !env.PUBLIC) return redirectToGoogle(url, env)

  // Share HTML runs on this origin with the viewer's cookie, so the pages
  // that hold private data (the token page, the listing, stats) answer only
  // top-level navigations: a share's fetch() or iframe gets a 403, and COOP
  // cuts the window.open() handle. Browsers without Sec-Fetch-* pass.
  const key = decodeURIComponent(url.pathname.slice(1))
  const priv = key === '' || key === '_token' || key === '_stats'
  if (priv) {
    const mode = req.headers.get('sec-fetch-mode')
    const dest = req.headers.get('sec-fetch-dest')
    if ((mode && mode !== 'navigate') || (dest && dest !== 'document')) {
      return new Response('forbidden\n', { status: 403 })
    }
  }

  const accept = req.headers.get('accept')
  const res = await serve(url, email, env, store, accept)
  if (priv) {
    res.headers.set('cross-origin-opener-policy', 'same-origin')
    res.headers.set('content-security-policy', "frame-ancestors 'none'")
    res.headers.set('x-frame-options', 'DENY')
  }

  // views: count successful browser navigations to share content. Assets
  // and hover previews fetch() with accept */*; _peek/_zip carry a /_ path.
  if (email && res.status === 200 && key && !key.startsWith('_') && !key.includes('/_')
      && accept?.includes('text/html')) {
    ctx.waitUntil(store.recordView(key.split('/')[0], email))
  }
  return res
}
