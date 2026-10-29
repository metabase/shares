import type { Env } from './env'
import {
  COOKIE, CONTENT_TAG, SESSION_DAYS, TICKET_SECONDS, handleCallback, redirectToGoogle, sessionEmail,
  authenticate, setCookie, signEmail, ticketTag, verifyEmail,
} from './auth'
import { cli } from './api/cli'
import { tokensApi } from './api/tokens'
import CLI_SH from '../bin/share' // text module (wrangler.toml rules)
import SKILL_MD from '../skill/SKILL.md'
import INSTALL_SH from '../cli/install.sh'
import { approvePath, deviceApi, formPost } from './web/tokens'
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
  const who = await authenticate(env, bearerOf(req))
  if (!who) return new Response('unauthorized\n', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  return await tokensApi(req, url, env, who) ?? cli(req, url, env, store, who.email)
}

// install.sh with the origin that served it as the default app URL, so
// `share login` after the install talks to the same deploy
const installScript = (url: URL, env: Env) =>
  new Response(INSTALL_SH.replaceAll('__APP_URL__', appBase(url, env) || url.origin),
    { headers: { 'content-type': 'text/x-shellscript; charset=utf-8' } })

// Requests that need no bearer token and no session: the CLI scripts and
// skill (the repo is public; `share login` needs the CLI first), and
// the device flow endpoints. null: none of these.
async function open(req: Request, url: URL, env: Env): Promise<Response | null> {
  if (req.method === 'GET' && !env.PUBLIC) {
    if (url.pathname === '/_cli') return new Response(CLI_SH)
    if (url.pathname === '/_skill') return new Response(SKILL_MD)
    if (url.pathname === '/_install.sh') return installScript(url, env)
  }
  return deviceApi(req, url, env)
}

// HTML form posts of a signed-in user: /_token (create, revoke) and the
// approve page of `share login`. A browser sends Origin on every POST; it
// must be this origin, so a page on another origin cannot submit them.
const isFormPost = (req: Request, url: URL, env: Env) => req.method === 'POST' && !env.PUBLIC
  && (url.pathname === '/_token' || url.pathname === approvePath(url, env))

async function form(req: Request, url: URL, env: Env, email: string | null) {
  if (req.headers.get('origin') !== url.origin) return forbidden()
  if (!email) return new Response('not signed in; reload the page\n', { status: 401 })
  return formPost(req, url, env, email)
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
const isPrivatePage = (key: string) => key === '' || key === '_token' || key === '_stats' || key === '_device'

// PUBLIC_SHARING: a share its owner marked public opens without login
// (SHR-9). Only share paths: private pages and _-prefixed paths never.
async function isPublicShare(env: Env, store: ShareStore, key: string) {
  const top = key.split('/')[0]
  return env.PUBLIC_SHARING === '1' && !!top && !top.startsWith('_') && store.isPublic(top)
}

// One origin for everything: hosts that match neither CONTENT_HOST nor
// APP_HOST (workers.dev, wrangler dev, the pubshare deploy). Share HTML runs
// on the origin that holds the session and the token page.
export async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const store = storeFor(env)

  const pub = await open(req, url, env)
  if (pub) return pub
  if (isFormPost(req, url, env)) return lockDown(await form(req, url, env, await sessionEmail(req, env)))
  if (isApi(req, url)) return api(req, url, env, store)

  if (url.pathname === '/auth/callback' && !env.PUBLIC) return handleCallback(url, env)

  // PUBLIC (pubshare deploy): anonymous read-only viewers, no login.
  // Writes still go through the bearer-token branch above.
  const email = env.PUBLIC ? null : await sessionEmail(req, env)
  const key = keyOf(url)
  if (!email && !env.PUBLIC && !await isPublicShare(env, store, key)) return redirectToGoogle(url, env)

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

  // PUBLIC: anonymous viewers; PUBLIC_SHARING: anonymous viewers of public shares
  const email = env.PUBLIC ? null : await sessionEmail(req, env, COOKIE.content, CONTENT_TAG)
  if (!email && !env.PUBLIC && !await isPublicShare(env, store, key)) {
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

  const pub = await open(req, url, env)
  if (pub) return pub
  if (url.pathname === '/install.sh' && req.method === 'GET' && !env.PUBLIC) return installScript(url, env)
  if (isFormPost(req, url, env)) return form(req, url, env, await sessionEmail(req, env, COOKIE.app))
  if (isApi(req, url)) return api(req, url, env, store)

  if (url.pathname === '/auth/callback' && !env.PUBLIC) return handleCallback(url, env, COOKIE.app)

  const key = keyOf(url)
  const peek = key.endsWith('/_peek')
  if (!isPrivatePage(key) && key !== '_login' && key !== 'cli' && !peek) {
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
