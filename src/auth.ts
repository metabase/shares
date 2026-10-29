import type { Env } from './env'

export const SESSION_DAYS = 7

export function b64url(bytes: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64email = (email: string) => b64url(new TextEncoder().encode(email))
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

export async function hmac(env: Env, data: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

// Personal CLI tokens are stateless: t.<emailB64>.<hmac("tok."+emailB64)>.
// Verification recomputes the hmac -- nothing stored, nothing to revoke short
// of rotating SESSION_SECRET. The "tok." prefix keeps tokens and session
// cookies from doubling as each other despite the shared secret. The legacy
// shared UPLOAD_TOKEN still works and acts as ADMIN_EMAIL.
export async function tokenEmail(env: Env, bearer: string): Promise<string | null> {
  if (!bearer) return null
  if (env.UPLOAD_TOKEN && bearer === env.UPLOAD_TOKEN) return env.ADMIN_EMAIL
  // PUBLIC has no login, so no personal tokens: UPLOAD_TOKEN is the only writer
  if (env.PUBLIC) return null
  const [tag, emailB64, sig] = bearer.split('.')
  if (tag !== 't' || !emailB64 || !sig) return null
  if (sig !== await hmac(env, `tok.${emailB64}`)) return null
  try { return unb64(emailB64) } catch { return null }
}

// Signed, expiring email: <emailB64>.<exp>.<hmac(tag + emailB64.exp)>. The
// tag keeps the values of one kind from doubling as another: '' for the app
// session (and the legacy single-host session), 'c.' for the content host
// cookie, 'tkt.<target>.' for login tickets.
export async function signEmail(env: Env, email: string, ttl: number, tag = '') {
  const emailB64 = b64email(email)
  const exp = Math.floor(Date.now() / 1000) + ttl
  return `${emailB64}.${exp}.${await hmac(env, `${tag}${emailB64}.${exp}`)}`
}

export async function verifyEmail(env: Env, value: string, tag = ''): Promise<string | null> {
  const [emailB64, exp, sig] = value.split('.')
  if (!emailB64 || !exp || !sig) return null
  if (Number(exp) < Date.now() / 1000) return null
  if (sig !== await hmac(env, `${tag}${emailB64}.${exp}`)) return null
  try { return unb64(emailB64) } catch { return null }
}

// Cookie names: 's' on the single host; __Host- on the split hosts, so the
// cookie is host-only, Secure, Path=/ and a sibling *.metabase.fyi host
// cannot set or shadow it.
export const COOKIE = { combined: 's', app: '__Host-s', content: '__Host-c' } as const
export const CONTENT_TAG = 'c.'

export function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1)
  }
  return null
}

export async function sessionEmail(req: Request, env: Env, name = 's', tag = ''): Promise<string | null> {
  const v = cookieValue(req, name)
  return v ? verifyEmail(env, v, tag) : null
}

export function setCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

// Login ticket: the app host signs the viewer's email and the target URL on
// the content host, valid TICKET_SECONDS. The content host accepts it only
// for that exact target, then sets its own cookie.
export const TICKET_SECONDS = 60
export const ticketTag = (target: string) => `tkt.${target}.`

export function redirectToGoogle(url: URL, env: Env) {
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  auth.searchParams.set('redirect_uri', `${url.origin}/auth/callback`)
  auth.searchParams.set('response_type', 'code')
  auth.searchParams.set('scope', 'openid email')
  auth.searchParams.set('hd', env.ALLOWED_DOMAIN) // UI hint only; enforced in callback
  // state carries the original path so login lands back on the requested share
  auth.searchParams.set('state', btoa(url.pathname + url.search))
  return Response.redirect(auth.toString(), 302)
}

export interface IdClaims {
  aud?: unknown
  iss?: unknown
  exp?: unknown
  email?: unknown
  email_verified?: unknown
  hd?: unknown
}

// The email of a Google id_token payload, or null when a claim fails. hd is
// the Workspace domain of the account: a consumer Google account made with a
// @metabase.com address has a verified @metabase.com email but no hd, so the
// email check alone does not identify an org account.
export function idTokenEmail(c: IdClaims, env: Env): string | null {
  const domain = env.ALLOWED_DOMAIN.toLowerCase()
  if (!env.GOOGLE_CLIENT_ID || c.aud !== env.GOOGLE_CLIENT_ID) return null
  if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') return null
  if (typeof c.exp !== 'number' || c.exp < Date.now() / 1000) return null
  if (c.email_verified !== true) return null
  if (typeof c.hd !== 'string' || c.hd.toLowerCase() !== domain) return null
  if (typeof c.email !== 'string') return null
  const email = c.email.toLowerCase()
  return email.endsWith(`@${domain}`) ? email : null
}

export async function handleCallback(url: URL, env: Env, cookie: string = COOKIE.combined) {
  const code = url.searchParams.get('code')
  if (!code) return new Response('missing code', { status: 400 })

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  })
  const tok = await r.json<{ id_token?: string }>()
  if (!tok.id_token) return new Response('auth failed', { status: 403 })

  // The id_token comes straight from Google's token endpoint over TLS in the
  // same request, so decoding without signature verification is sound here.
  let email: string | null = null
  try {
    email = idTokenEmail(JSON.parse(unb64(tok.id_token.split('.')[1])), env)
  } catch {}
  if (!email) return new Response(`access limited to @${env.ALLOWED_DOMAIN} accounts`, { status: 403 })

  const session = await signEmail(env, email, SESSION_DAYS * 86400)

  let dest = '/'
  try { dest = atob(url.searchParams.get('state') || '') || '/' } catch {}
  // must be a same-origin absolute path: "//host" and "/\host" are
  // protocol-relative redirects in browsers -> open redirect
  if (!/^\/(?![/\\])/.test(dest)) dest = '/'

  return new Response(null, {
    status: 302,
    headers: {
      location: dest,
      'set-cookie': setCookie(cookie, session, SESSION_DAYS * 86400),
    },
  })
}
