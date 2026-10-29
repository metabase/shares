import type { Env } from './env'
import {
  COOKIE, CONTENT_TAG, SESSION_DAYS, TICKET_SECONDS, handleCallback, redirectToGoogle, sessionEmail,
  setCookie, signEmail, ticketTag, tokenEmail, verifyEmail,
} from './auth'
import { cli } from './api/cli'
import { serve } from './web/serve'
import { notFound } from './render/page'
import { storeFor, type ShareStore } from './store'
import { appBase, contentBase } from './origins'

// a same-origin absolute path: "//host" and "/\host" are protocol-relative
// in browsers, so they would redirect to another host
const isLocalPath = (p: string) => /^\/(?![/\\])/.test(p)

const forbidden = () => new Response('forbidden\n', { status: 403 })

// CLI endpoints: bearer token, no cookies involved. Bearer GET serves raw
// bytes (for `share download`); browsers never send one.
function isApi(req: Request, url: URL) {
  return req.method === 'PUT' || req.method === 'DELETE' || req.method === 'POST'
    || url.pathname === '/_list' || (req.method === 'GET' && !!bearerOf(req))
}

const bearerOf = (req: Request) => (req.headers.get('authorization') || '').replace(/^Bearer /, '')

async function api(req: Request, url: URL, env: Env, store: ShareStore) {
  const who = await tokenEmail(env, bearerOf(req))
  if (!who) return new Response('forbidden', { status: 403 })
  return cli(req, url, env, store, who)
}

// Pages that hold private data answer only top-level navigations: a fetch()
// or an iframe from a share gets a 403. Browsers without Sec-Fetch-* pass.
function isNavigation(req: Request) {
  const mode = req.headers.get('sec-fetch-mode')
  const dest = req.headers.get('sec-fetch-dest')
  return !(mode && mode !== 'navigate') && !(dest && dest !== 'document')
}

function lockDown(res: Response) {
  // Response.redirect() has immutable headers
  const out = new Response(res.body, res)
  out.headers.set('cross-origin-opener-policy', 'same-origin')
  out.headers.set('content-security-policy', "frame-ancestors 'none'")
  out.headers.set('x-frame-options', 'DENY')
  return out
}

// views: count successful browser navigations to share content. Assets
// and hover previews fetch() with accept */*; _peek/_zip carry a /_ path.
function recordView(ctx: ExecutionContext, store: ShareStore, key: string, email: string | null,
  res: Response, accept: string | null) {
  if (email && res.status === 200 && key && !key.startsWith('_') && !key.includes('/_')
      && accept?.includes('text/html')) {
    ctx.waitUntil(store.recordView(key.split('/')[0], email))
  }
}

const keyOf = (url: URL) => decodeURIComponent(url.pathname.slice(1))
const isPrivatePage = (key: string) => key === '' || key === '_token' || key === '_stats'

// One origin for everything: hosts that match neither CONTENT_HOST nor
// APP_HOST (workers.dev, wrangler dev, the pubshare deploy). Share HTML runs
// on the origin that holds the session and the token page.
export async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const store = storeFor(env)

  if (isApi(req, url)) return api(req, url, env, store)

  if (url.pathname === '/auth/callback' && !env.PUBLIC) return handleCallback(url, env)

  // PUBLIC (pubshare deploy): anonymous read-only viewers, no login.
  // Writes still go through the bearer-token branch above.
  const email = env.PUBLIC ? null : await sessionEmail(req, env)
  if (!email && !env.PUBLIC) return redirectToGoogle(url, env)

  const key = keyOf(url)
  const priv = isPrivatePage(key)
  if (priv && !isNavigation(req)) return forbidden()

  const accept = req.headers.get('accept')
  const res = await serve(url, email, env, store, accept)
  recordView(ctx, store, key, email, res, accept)
  return priv ? lockDown(res) : res
}

// Content host: share files and their renderers only. No API, no tokens,
// no app cookie: script in a share runs here and the app host does not
// answer it with CORS, so it cannot read any app-host response.
export async function contentHost(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const app = appBase(url, env)
  const store = storeFor(env)

  if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.has('authorization')) {
    return new Response(`the API is on ${app}\n`, { status: 403 })
  }

  if (url.pathname === '/_auth') return acceptTicket(url, env)

  const key = keyOf(url)
  if (isPrivatePage(key)) return Response.redirect(`${app}/${key}`, 302)

  // PUBLIC: anonymous viewers. The per-share public bit is SHR-9.
  const email = env.PUBLIC ? null : await sessionEmail(req, env, COOKIE.content, CONTENT_TAG)
  if (!email && !env.PUBLIC) {
    return Response.redirect(`${app}/_login?to=${encodeURIComponent(url.pathname + url.search)}`, 302)
  }

  const accept = req.headers.get('accept')
  const res = await serve(url, email, env, store, accept)
  recordView(ctx, store, key, email, res, accept)
  return res
}

// /_auth?to=PATH&t=TICKET: the last step of the content host login. The
// ticket is valid only for this origin + PATH; the response sets the
// host-only content cookie and goes on to PATH.
async function acceptTicket(url: URL, env: Env) {
  const to = url.searchParams.get('to') || ''
  const email = isLocalPath(to)
    ? await verifyEmail(env, url.searchParams.get('t') || '', ticketTag(url.origin + to))
    : null
  if (!email) return new Response('login ticket invalid or expired; reload the share\n', { status: 403 })
  const cookie = await signEmail(env, email, SESSION_DAYS * 86400, CONTENT_TAG)
  return new Response(null, {
    status: 302,
    headers: {
      location: to,
      'set-cookie': setCookie(COOKIE.content, cookie, SESSION_DAYS * 86400),
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })
}

// App host: API, login, tokens and the UI. Share content goes to the
// content host. Every response refuses framing.
export async function appHost(req: Request, env: Env): Promise<Response> {
  return lockDown(await appRoutes(req, env))
}

async function appRoutes(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const store = storeFor(env)

  // writes come from the CLI (no Origin) or from app pages (same origin)
  const origin = req.headers.get('origin')
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== url.origin) return forbidden()

  if (isApi(req, url)) return api(req, url, env, store)

  if (url.pathname === '/auth/callback' && !env.PUBLIC) return handleCallback(url, env, COOKIE.app)

  const key = keyOf(url)
  const peek = key.endsWith('/_peek')
  if (!isPrivatePage(key) && key !== '_login' && !peek) {
    return Response.redirect(`${contentBase(url, env)}${url.pathname}${url.search}`, 302)
  }
  if (env.PUBLIC) return notFound()

  // _peek feeds the hover previews of the listing page, a same-origin fetch
  const site = req.headers.get('sec-fetch-site')
  if (peek ? site && site !== 'same-origin' : !isNavigation(req)) return forbidden()

  const email = await sessionEmail(req, env, COOKIE.app)
  if (!email) return redirectToGoogle(url, env)

  if (key === '_login') {
    const to = url.searchParams.get('to') || '/'
    if (!isLocalPath(to)) return new Response('bad target\n', { status: 400 })
    const target = contentBase(url, env) + to
    const t = await signEmail(env, email, TICKET_SECONDS, ticketTag(target))
    const next = new URL(`${contentBase(url, env)}/_auth`)
    next.searchParams.set('to', to)
    next.searchParams.set('t', t)
    return new Response(null, {
      status: 302,
      headers: { location: next.toString(), 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' },
    })
  }

  return serve(url, email, env, store, req.headers.get('accept'))
}
