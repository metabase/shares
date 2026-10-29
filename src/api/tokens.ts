// Bearer endpoints for CLI tokens: whoami, list, and revoke (`share logout`
// revokes "current", the token of the request). The admin also creates,
// lists and revokes service tokens (SHR-13). Types: api-types.ts.

import type { Env } from '../env'
import type { ServiceTokenCreate, ServiceTokenInfo, WhoAmI } from '../api-types'
import {
  AGENT_NAME, SCOPE, TOKEN_DAYS, createServiceToken, listServiceTokens, listTokens, revokeServiceToken, revokeToken,
  type ServiceTokenRow,
} from '../tokens'
import { tokenInfo } from '../web/tokens'

const serviceInfo = (t: ServiceTokenRow): ServiceTokenInfo => ({
  ...tokenInfo(t), created_by: t.owner, scopes: JSON.parse(t.scopes), on_behalf_of: t.on_behalf_of,
})

// the body of POST /_api/tokens, else an error message. The admin form
// of /_token checks its fields with it too.
export function serviceSpec(b: Partial<ServiceTokenCreate>, env: Env): ServiceTokenCreate | string {
  if (typeof b.name !== 'string' || !AGENT_NAME.test(b.name)) return 'bad name: [a-z0-9._-], at most 64'
  if (!Array.isArray(b.scopes) || !b.scopes.length || !b.scopes.every((s) => typeof s === 'string' && SCOPE.test(s))) {
    return 'bad scopes: a list of read:<collection> or write:<collection>, a trailing * matches any rest'
  }
  const obo = b.on_behalf_of
  if (obo !== undefined && obo !== null
    && (typeof obo !== 'string' || obo !== obo.toLowerCase() || !obo.endsWith(`@${env.ALLOWED_DOMAIN}`))) {
    return `bad on_behalf_of: a lowercase @${env.ALLOWED_DOMAIN} email`
  }
  if (b.expires_days !== undefined && !(Number.isInteger(b.expires_days) && b.expires_days >= 1 && b.expires_days <= TOKEN_DAYS)) {
    return `bad expires_days: 1 to ${TOKEN_DAYS}`
  }
  return { name: b.name, scopes: b.scopes, on_behalf_of: obo ?? null, expires_days: b.expires_days }
}

const error = (status: number, msg: string) => Response.json({ error: msg }, { status })

// null: not a token endpoint
export async function tokensApi(req: Request, url: URL, env: Env,
  who: { email: string; id: string | null }): Promise<Response | null> {
  const p = url.pathname
  if (p === '/_api/whoami' && req.method === 'GET') {
    return Response.json({ kind: 'user', email: who.email, admin: who.email === env.ADMIN_EMAIL, token: who.id } satisfies WhoAmI)
  }
  if (p !== '/_api/tokens' && !p.startsWith('/_api/tokens/')) return null
  if (!env.DB) return error(501, 'not supported')
  const admin = who.email === env.ADMIN_EMAIL
  const service = url.searchParams.get('kind') === 'service'

  if (p === '/_api/tokens' && req.method === 'GET') {
    if (service) {
      if (!admin) return error(403, 'forbidden')
      return Response.json((await listServiceTokens(env)).map(serviceInfo))
    }
    return Response.json((await listTokens(env, who.email)).map(tokenInfo))
  }
  // a new service token, shown once
  if (p === '/_api/tokens' && req.method === 'POST') {
    if (!admin) return error(403, 'forbidden')
    let b: Partial<ServiceTokenCreate>
    try { b = await req.json() } catch { return error(400, 'bad json') }
    const spec = serviceSpec(b ?? {}, env)
    if (typeof spec === 'string') return error(400, spec)
    const { id, token } = await createServiceToken(env, who.email,
      { name: spec.name, scopes: spec.scopes, on_behalf_of: spec.on_behalf_of, days: spec.expires_days })
    return Response.json({ id, token, name: spec.name, scopes: spec.scopes, on_behalf_of: spec.on_behalf_of ?? null })
  }
  if (req.method === 'DELETE') {
    let id = decodeURIComponent(p.slice('/_api/tokens/'.length))
    if (id === 'current') {
      if (!who.id) return error(400, 'the shared UPLOAD_TOKEN cannot be revoked')
      id = who.id
    }
    const done = service
      ? admin && await revokeServiceToken(env, who.email, id)
      : await revokeToken(env, who.email, id)
    if (!done) return error(404, 'no live token with that id')
    return Response.json({ revoked: id })
  }
  return error(405, 'method not allowed')
}
