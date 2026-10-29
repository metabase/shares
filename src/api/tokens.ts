// Bearer endpoints for CLI tokens: whoami, list, and revoke (`share logout`
// revokes "current", the token of the request). Types: api-types.ts.

import type { Env } from '../env'
import type { WhoAmI } from '../api-types'
import { listTokens, revokeToken } from '../tokens'
import { tokenInfo } from '../web/tokens'

const error = (status: number, msg: string) => Response.json({ error: msg }, { status })

// null: not a token endpoint
export async function tokensApi(req: Request, url: URL, env: Env,
  who: { email: string; id: string | null }): Promise<Response | null> {
  const p = url.pathname
  if (p === '/_api/whoami' && req.method === 'GET') {
    return Response.json({ email: who.email, admin: who.email === env.ADMIN_EMAIL, token: who.id } satisfies WhoAmI)
  }
  if (p !== '/_api/tokens' && !p.startsWith('/_api/tokens/')) return null
  if (!env.DB) return error(501, 'not supported')

  if (p === '/_api/tokens' && req.method === 'GET') {
    return Response.json((await listTokens(env, who.email)).map(tokenInfo))
  }
  if (req.method === 'DELETE') {
    let id = decodeURIComponent(p.slice('/_api/tokens/'.length))
    if (id === 'current') {
      if (!who.id) return error(400, 'the shared UPLOAD_TOKEN cannot be revoked')
      id = who.id
    }
    if (!await revokeToken(env, who.email, id)) return error(404, 'no live token with that id')
    return Response.json({ revoked: id })
  }
  return error(405, 'method not allowed')
}
