import { env, exports } from 'cloudflare:workers'
import { b64url, hmac } from '../src/auth'

export const ORIGIN = 'https://shares.test'
export const ADMIN = env.ADMIN_EMAIL

const emailB64 = (email: string) => b64url(new TextEncoder().encode(email))

export async function userToken(email: string) {
  return `t.${emailB64(email)}.${await hmac(env, `tok.${emailB64(email)}`)}`
}

export async function sessionCookie(email: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  return `s=${emailB64(email)}.${exp}.${await hmac(env, `${emailB64(email)}.${exp}`)}`
}

export function fetchWorker(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }))
}

// CLI request with a bearer token (default: the admin UPLOAD_TOKEN)
export function api(method: string, path: string, opts: { token?: string; body?: BodyInit } = {}) {
  return fetchWorker(path, {
    method,
    body: opts.body,
    headers: { authorization: `Bearer ${opts.token ?? env.UPLOAD_TOKEN}` },
  })
}

// top-level browser navigation with a session for `email`
export async function browse(path: string, email = ADMIN, headers: Record<string, string> = {}) {
  return fetchWorker(path, {
    headers: {
      cookie: await sessionCookie(email),
      accept: 'text/html,*/*',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      ...headers,
    },
  })
}

let n = 0
export const slug = (name: string) => `${name}-${Date.now().toString(36)}${n++}`

// the CLI's publish sequence: PUT each file, then finalize
export async function publish(top: string, files: Record<string, string>, token?: string) {
  for (const [path, body] of Object.entries(files)) {
    const r = await api('PUT', `/${top}/${path}`, { token, body })
    if (r.status !== 200) return r
  }
  return api('POST', `/_finalize/${top}`, { token, body: Object.keys(files).join('\n') })
}
