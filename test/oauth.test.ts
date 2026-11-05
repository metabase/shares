import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { b64url, hmac, idTokenEmail, signEmail, verifyEmail, type IdClaims } from '../src/auth'
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

describe('a signed session or ticket value', () => {
  const emailB64 = b64url(new TextEncoder().encode('pat@metabase.com'))

  it('verifies as signed', async () => {
    expect(await verifyEmail(env, await signEmail(env, 'pat@metabase.com', 60))).toBe('pat@metabase.com')
  })

  it('refuses a fourth segment after a valid value', async () => {
    expect(await verifyEmail(env, `${await signEmail(env, 'pat@metabase.com', 60)}.anything`)).toBeNull()
  })

  // Number() reads each of these as a time far in the future,
  // so only the digits test refuses them once they carry a valid signature.
  it.each(['Infinity', '1e12', '0x7fffffff'])('refuses a signed exp of %s', async (exp) => {
    expect(await verifyEmail(env, `${emailB64}.${exp}.${await hmac(env, `${emailB64}.${exp}`)}`)).toBeNull()
  })

  it('refuses a signature spelled another way', async () => {
    const value = await signEmail(env, 'pat@metabase.com', 60)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    // The last character carries two spare bits,
    // so flipping one leaves the decoded signature as it was.
    const last = alphabet[alphabet.indexOf(value.at(-1)!) ^ 1]
    expect(await verifyEmail(env, `${value.slice(0, -1)}${last}`)).toBeNull()
  })

  const bytesOf = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

  it.each<[string, (sig: string) => string]>([
    ['a signature that is not base64', () => '%%%'],
    ['a valid signature cut to 31 bytes', (sig) => b64url(bytesOf(sig).slice(0, 31))],
    ['a valid signature with a 33rd byte', (sig) => b64url(new Uint8Array([...bytesOf(sig), 0]))],
    // Two million characters decode to 1.5 million bytes,
    // more than V8 lets one call take as spread arguments.
    ['a signature of two million characters', () => 'A'.repeat(2_000_000)],
  ])('refuses %s', async (_, resize) => {
    const [e, exp, sig] = (await signEmail(env, 'pat@metabase.com', 60)).split('.')
    expect(await verifyEmail(env, `${e}.${exp}.${resize(sig)}`)).toBeNull()
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
