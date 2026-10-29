import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { b64url, idTokenEmail, verifyEmail, type IdClaims } from '../src/auth'
import { APP, fetchWorker } from './helpers'

const claims = (over: IdClaims = {}): IdClaims => ({
  aud: env.GOOGLE_CLIENT_ID,
  iss: 'https://accounts.google.com',
  exp: Math.floor(Date.now() / 1000) + 300,
  email: 'Pat@metabase.com',
  email_verified: true,
  hd: 'metabase.com',
  ...over,
})

const idToken = (c: IdClaims) =>
  `${b64url(new TextEncoder().encode('{"alg":"RS256"}'))}.${b64url(new TextEncoder().encode(JSON.stringify(c)))}.sig`

// Google's token endpoint answers with this id_token for the next callback
function googleReturns(c: IdClaims) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    expect(new Request(input).url).toBe('https://oauth2.googleapis.com/token')
    return Response.json({ id_token: idToken(c) })
  })
}

const callback = (state = '/_login?to=%2Fx%2F') =>
  fetchWorker(`/auth/callback?code=c&state=${btoa(state)}`, undefined, APP)

afterEach(() => { vi.restoreAllMocks() })

describe('id_token claims', () => {
  it('accepts a verified org account and returns its email in lower case', () => {
    expect(idTokenEmail(claims(), env)).toBe('pat@metabase.com')
    expect(idTokenEmail(claims({ iss: 'accounts.google.com' }), env)).toBe('pat@metabase.com')
  })

  it.each<[string, IdClaims]>([
    ['another client', { aud: 'other.apps.googleusercontent.com' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['an unverified email', { email_verified: false }],
    ['email_verified as a string', { email_verified: 'true' }],
    ['a personal Gmail account', { email: 'pat@gmail.com', hd: undefined }],
    ['a consumer account with an org address and no hd', { hd: undefined }],
    ['another Workspace domain', { hd: 'example.com', email: 'pat@example.com' }],
    ['an org hd with an email of another domain', { email: 'pat@metabase.com.evil.example' }],
    ['no email', { email: undefined }],
  ])('refuses %s', (_, over) => {
    expect(idTokenEmail(claims(over), env)).toBeNull()
  })
})

describe('OAuth callback on the app host', () => {
  it('sets the app session for an org account and returns to the state path', async () => {
    googleReturns(claims())
    const r = await callback()
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/_login?to=%2Fx%2F')
    const value = r.headers.get('set-cookie')!.match(/^__Host-s=([^;]+)/)![1]
    expect(await verifyEmail(env, value)).toBe('pat@metabase.com')
  })

  it('refuses a personal Gmail account and sets no cookie', async () => {
    googleReturns(claims({ email: 'pat@gmail.com', hd: undefined }))
    const r = await callback()
    expect(r.status).toBe(403)
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a malformed id_token', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id_token: 'not-a-jwt' }))
    expect((await callback()).status).toBe(403)
  })
})
