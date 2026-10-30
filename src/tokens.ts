// Revocable CLI tokens and the `share login` device flow, in D1 (tables
// tokens and device_codes). A token is shr_<id>_<secret>; D1 keeps only the
// sha256 of the whole token. Each request reads the row, so a revoke is
// effective at once.

import type { Env } from './env'

export const TOKEN_DAYS = 365
export const DEVICE_SECONDS = 600
export const POLL_SECONDS = 2
// a last_used_at write at most once a minute per token
const TOUCH_MS = 60_000

export interface TokenRow {
  id: string
  name: string
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  revoked_at: number | null
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

// a row of the audit table (migration 0002): token.create, token.revoke
const audit = (env: Env, actor: string, action: string, detail: Record<string, string>) =>
  env.DB.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .bind(Date.now(), actor, action, JSON.stringify(detail))

export async function sha256(s: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

export const isToken = (s: string) => /^shr_[0-9a-f]{12}_[0-9a-f]{64}$/.test(s)

export async function createToken(env: Env, owner: string, name: string) {
  const id = hex(random(6))
  const token = `shr_${id}_${hex(random(32))}`
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(owner, now),
    env.DB.prepare(`INSERT INTO tokens (id, hash, name, owner, kind, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?)`)
      .bind(id, await sha256(token), name.slice(0, 100) || 'cli', owner, now, now + TOKEN_DAYS * 86400_000),
    audit(env, owner, 'token.create', { id, name }),
  ])
  return { id, token }
}

// A live token, else null. A user token acts as its owner; a service token
// acts as `agent:<name>` within its scopes (api/service.ts).
export type TokenCaller =
  | { kind: 'user'; email: string; id: string }
  | ServiceCaller

export interface ServiceCaller {
  kind: 'service'
  id: string
  // agent:<name>: uploader of its versions and actor of its audit rows
  agent: string
  // owner of the shares it makes: on_behalf_of, else the agent
  email: string
  scopes: string[]
}

export async function verifyToken(env: Env, token: string): Promise<TokenCaller | null> {
  if (!env.DB || !isToken(token)) return null
  const row = await env.DB.prepare(`SELECT id, name, owner, kind, scopes, on_behalf_of, last_used_at, expires_at, revoked_at
    FROM tokens WHERE hash = ?`).bind(await sha256(token)).first<{
      id: string; name: string; owner: string; kind: 'user' | 'service'; scopes: string; on_behalf_of: string | null
      last_used_at: number | null; expires_at: number | null; revoked_at: number | null
    }>()
  const now = Date.now()
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null
  if (!row.last_used_at || row.last_used_at < now - TOUCH_MS) {
    await env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()
  }
  if (row.kind === 'user') return { kind: 'user', email: row.owner, id: row.id }
  const agent = `agent:${row.name}`
  return { kind: 'service', id: row.id, agent, email: row.on_behalf_of ?? agent, scopes: JSON.parse(row.scopes) }
}

export async function listTokens(env: Env, owner: string) {
  const { results } = await env.DB.prepare(`SELECT id, name, created_at, last_used_at, expires_at, revoked_at
    FROM tokens WHERE owner = ? AND kind = 'user' ORDER BY created_at DESC`).bind(owner).all<TokenRow>()
  return results
}

// true when a live token of this owner was revoked
export async function revokeToken(env: Env, owner: string, id: string) {
  const r = await env.DB.prepare(`UPDATE tokens SET revoked_at = ?
    WHERE id = ? AND owner = ? AND kind = 'user' AND revoked_at IS NULL`).bind(Date.now(), id, owner).run()
  if (r.meta.changes) await audit(env, owner, 'token.revoke', { id }).run()
  return r.meta.changes > 0
}

// Service tokens: made by the admin for agents and CI. Scopes are
// "read:<pattern>" or "write:<pattern>" over collection slugs; a trailing
// "*" matches any rest (metareview/* matches metareview/run-1). Write
// implies read. Name: the agent, [a-z0-9._-].
export const SCOPE = /^(read|write):[a-z0-9][a-z0-9._/-]*\*?$|^(read|write):\*$/
export const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface ServiceTokenRow extends TokenRow {
  owner: string
  scopes: string
  on_behalf_of: string | null
}

export async function createServiceToken(env: Env, admin: string,
  t: { name: string; scopes: string[]; on_behalf_of?: string | null; days?: number }) {
  const id = hex(random(6))
  const token = `shr_${id}_${hex(random(32))}`
  const now = Date.now()
  const scopes = JSON.stringify(t.scopes)
  const users = [...new Set([admin, t.on_behalf_of].filter((e): e is string => !!e))]
  await env.DB.batch([
    ...users.map((e) => env.DB.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(e, now)),
    env.DB.prepare(`INSERT INTO tokens (id, hash, name, owner, kind, scopes, on_behalf_of, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'service', ?, ?, ?, ?)`)
      .bind(id, await sha256(token), t.name, admin, scopes, t.on_behalf_of ?? null, now,
        now + (t.days ?? TOKEN_DAYS) * 86400_000),
    audit(env, admin, 'token.create', {
      id, name: t.name, kind: 'service', scopes, ...(t.on_behalf_of ? { on_behalf_of: t.on_behalf_of } : {}),
    }),
  ])
  return { id, token }
}

export async function listServiceTokens(env: Env) {
  const { results } = await env.DB.prepare(`SELECT id, name, owner, scopes, on_behalf_of, created_at, last_used_at,
    expires_at, revoked_at FROM tokens WHERE kind = 'service' ORDER BY created_at DESC`).all<ServiceTokenRow>()
  return results
}

// admin: true when a live service token was revoked
export async function revokeServiceToken(env: Env, admin: string, id: string) {
  const r = await env.DB.prepare(`UPDATE tokens SET revoked_at = ?
    WHERE id = ? AND kind = 'service' AND revoked_at IS NULL`).bind(Date.now(), id).run()
  if (r.meta.changes) await audit(env, admin, 'token.revoke', { id, kind: 'service' }).run()
  return r.meta.changes > 0
}

// Device flow (RFC 8628 shape). The CLI gets a device code (secret, for
// polling) and a user code (for the person). The approve page sets
// approved_by; the poll that sees it deletes the row and creates the token,
// so a token exists only once the CLI holds it.

// no vowels: codes do not spell words; no 0/O, 1/I
const USER_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export const formatUserCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`
export const normalizeUserCode = (c: string) => c.toUpperCase().replace(/[^A-Z]/g, '')

export async function startDevice(env: Env, name: string) {
  const now = Date.now()
  const deviceCode = hex(random(32))
  const userCode = [...random(8)].map((b) => USER_ALPHABET[b % USER_ALPHABET.length]).join('')
  await env.DB.batch([
    env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(now),
    env.DB.prepare(`INSERT INTO device_codes (device_hash, user_code, name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(await sha256(deviceCode), userCode, name.slice(0, 100) || 'cli', now, now + DEVICE_SECONDS * 1000),
  ])
  return { deviceCode, userCode }
}

export interface DeviceRow {
  user_code: string
  name: string
  created_at: number
  approved_by: string | null
  denied: number
}

// a pending request by user code, for the approve page
export async function deviceByUserCode(env: Env, userCode: string) {
  return env.DB.prepare(`SELECT user_code, name, created_at, approved_by, denied FROM device_codes
    WHERE user_code = ? AND expires_at > ?`).bind(normalizeUserCode(userCode), Date.now()).first<DeviceRow>()
}

// true when a pending request was approved (or denied)
export async function decideDevice(env: Env, userCode: string, email: string, approve: boolean) {
  const sql = approve
    ? 'UPDATE device_codes SET approved_by = ? WHERE user_code = ? AND expires_at > ? AND approved_by IS NULL AND denied = 0'
    : 'UPDATE device_codes SET denied = 1 WHERE ? IS NOT NULL AND user_code = ? AND expires_at > ? AND approved_by IS NULL AND denied = 0'
  const r = await env.DB.prepare(sql).bind(email, normalizeUserCode(userCode), Date.now()).run()
  return r.meta.changes > 0
}

export type PollResult =
  | { error: 'authorization_pending' | 'access_denied' | 'expired_token' }
  | { token: string; email: string; name: string }

export async function pollDevice(env: Env, deviceCode: string): Promise<PollResult> {
  const hash = await sha256(deviceCode)
  const row = await env.DB.prepare('SELECT expires_at, approved_by, denied FROM device_codes WHERE device_hash = ?')
    .bind(hash).first<{ expires_at: number; approved_by: string | null; denied: number }>()
  if (!row || row.expires_at <= Date.now()) return { error: 'expired_token' }
  if (row.denied) {
    await env.DB.prepare('DELETE FROM device_codes WHERE device_hash = ?').bind(hash).run()
    return { error: 'access_denied' }
  }
  if (!row.approved_by) return { error: 'authorization_pending' }
  // one poll wins the row; a parallel poll sees no row
  const won = await env.DB.prepare(`DELETE FROM device_codes WHERE device_hash = ? AND approved_by IS NOT NULL
    RETURNING approved_by, name`).bind(hash).first<{ approved_by: string; name: string }>()
  if (!won) return { error: 'expired_token' }
  const { token } = await createToken(env, won.approved_by, won.name)
  return { token, email: won.approved_by, name: won.name }
}
