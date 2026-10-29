// Bearer endpoints for service tokens (SHR-13): agents and CI. Deny by
// default: a service token reaches only the routes below, and only for
// collections that its scopes match. A share is in scope when its
// collection is; a share without a collection never is. Shapes:
// api-types.ts.

import type { Env } from '../env'
import { baseSlug, isQueryStore, pinned, StoreError } from '../store'
import type { CommitFile, QueryStore, ShareAttrs, ShareStore } from '../store'
import type { ServiceCaller } from '../tokens'
import { revokeServiceToken } from '../tokens'
import { badSlug, publishResponse } from './cli'

type Access = 'read' | 'write'

// "write:metareview/*" matches write and read of metareview/run-1
export function allows(scopes: string[], access: Access, collection: string | null | undefined) {
  if (!collection) return false
  return scopes.some((s) => {
    const i = s.indexOf(':')
    const kind = s.slice(0, i)
    if (kind !== 'write' && kind !== access) return false
    const pat = s.slice(i + 1)
    return pat.endsWith('*') ? collection.startsWith(pat.slice(0, -1)) : collection === pat
  })
}

const error = (status: number, message: string) => Response.json({ error: message }, { status })
const lines = (xs: string[]) => new Response(xs.join('\n') + (xs.length ? '\n' : ''))
const outOfScope = () => error(403, 'out of token scope')

async function body<T>(req: Request) {
  try { return await req.json() as T } catch { throw new StoreError(400, 'bad json') }
}

export async function serviceApi(req: Request, url: URL, env: Env, store: ShareStore, who: ServiceCaller): Promise<Response> {
  if (!isQueryStore(store)) return error(501, 'not supported')
  try {
    return await dispatch(req, url, env, store, who)
  } catch (e) {
    if (e instanceof StoreError) return error(e.status, e.message)
    throw e
  }
}

// the D1+R2 store: it has the versioned publish methods too
async function dispatch(req: Request, url: URL, env: Env, store: ShareStore & QueryStore,
  who: ServiceCaller): Promise<Response> {
  const can = (access: Access, collection: string | null | undefined) => allows(who.scopes, access, collection)
  // a share is in scope when it exists and its collection matches; a
  // version read path is in scope when its share is
  const shareIn = async (access: Access, top: string) => can(access, (await store.share(baseSlug(top)))?.collection)
  const key = decodeURIComponent(url.pathname.slice(1))
  const get = req.method === 'GET'

  if (key === '_api/tokens/current' && req.method === 'DELETE') {
    await revokeServiceToken(env, who.agent, who.id)
    return Response.json({ revoked: who.id })
  }

  // blobs are content addressed: an upload changes no share
  if (key === '_blobs/missing' && req.method === 'POST') {
    return lines(await store.missingBlobs!((await req.text()).split('\n').map((s) => s.trim()).filter(Boolean)))
  }
  if (key.startsWith('_blobs/') && req.method === 'PUT') {
    await store.putBlob!(key.slice('_blobs/'.length), await req.arrayBuffer())
    return new Response('ok\n')
  }

  // the new collection and, for an existing share, its current one must
  // be in write scope
  if (key.startsWith('_publish/') && req.method === 'POST') {
    const top = key.slice('_publish/'.length).replace(/\/$/, '')
    if (badSlug(top)) return error(400, 'bad slug')
    const b = await body<{ files?: CommitFile[]; message?: string } & ShareAttrs>(req)
    if (!Array.isArray(b.files)) return error(400, 'files missing')
    const share = await store.share(top)
    const collection = b.collection === undefined ? share?.collection : b.collection
    if (!can('write', collection) || (share && !can('write', share.collection))) return outOfScope()
    const { title, meta } = b
    const version = await store.commit!(top, b.files, who.agent, b.message, { title, collection, meta }, who.email)
    return Response.json(publishResponse(url, env, top, version))
  }

  if (key === '_api/collections' && get) {
    return Response.json((await store.collections(url.searchParams.get('prefix') ?? '')).filter((c) => can('read', c.slug)))
  }
  if (key.startsWith('_api/collections/')) {
    const slug = key.slice('_api/collections/'.length)
    if (get) {
      if (!can('read', slug)) return outOfScope()
      const c = await store.collection(slug)
      return c ? Response.json(c) : error(404, 'not found')
    }
    if (req.method !== 'PUT') return error(405, 'method not allowed')
    if (!can('write', slug)) return outOfScope()
    return Response.json(await store.putCollection(slug, await body(req), who.email))
  }

  if (key === '_api/shares' && get) {
    const q = url.searchParams
    const collection = q.get('collection')
    if (!can('read', collection)) return outOfScope()
    const limit = Number(q.get('limit') ?? 100)
    const before = q.has('before') ? Number(q.get('before')) : undefined
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return error(400, 'bad limit: 1 to 1000')
    if (before !== undefined && !Number.isFinite(before)) return error(400, 'bad before')
    const meta: Record<string, string> = {}
    for (const [k, v] of q) if (k.startsWith('meta.')) meta[k.slice('meta.'.length)] = v
    return Response.json(await store.queryShares({
      collection: collection!, owner: q.get('owner') ?? undefined, meta, limit, before,
    }))
  }
  if (key.startsWith('_api/shares/')) {
    const [slug, sub, ...extra] = key.slice('_api/shares/'.length).split('/')
    if (extra.length || !slug || slug.startsWith('_')) return error(404, 'not found')
    const share = await store.share(slug)
    if (!share || !can('read', share.collection)) return outOfScope()
    if (sub === undefined && req.method === 'POST') {
      const attrs = await body<ShareAttrs>(req)
      if (!can('write', share.collection)
        || (attrs.collection !== undefined && !can('write', attrs.collection))) return outOfScope()
      await store.setAttrs(slug, attrs, who.agent)
      return Response.json(await store.share(slug))
    }
    if (!get) return error(405, 'method not allowed')
    if (sub === undefined) return Response.json(share)
    if (sub === 'versions') return Response.json(await store.versions(slug))
    if (sub === 'manifest') {
      const v = url.searchParams.get('version')
      if (v !== null && !/^[1-9][0-9]*$/.test(v)) return error(400, 'bad version')
      const m = await store.shareManifest(slug, v === null ? undefined : Number(v))
      return m ? Response.json(m) : error(404, 'not found')
    }
    return error(404, 'not found')
  }

  // `share ls`, `share cat`, `share download` of an in-scope share
  if (key === '_list' && get) {
    const prefix = url.searchParams.get('prefix') ?? ''
    const top = prefix.replace(/\/.*$/, '')
    if (!top || top.startsWith('_') || !prefix.startsWith(`${top}/`)) return outOfScope()
    if (!await shareIn('read', top)) return outOfScope()
    return lines(await store.filesUnder(prefix))
  }
  if (key.startsWith('_')) return outOfScope()
  const top = key.replace(/\/.*$/, '')
  if (get && key.includes('/') && !key.endsWith('/_views')) {
    if (!await shareIn('read', top)) return outOfScope()
    const b = await store.getStream(key)
    return b === null ? new Response('not found', { status: 404 }) : new Response(b)
  }
  // DELETE /<slug>/ removes the whole share
  if (req.method === 'DELETE' && key === `${top}/` && !pinned(top)) {
    if (!await shareIn('write', top)) return outOfScope()
    return new Response(`deleted ${await store.deleteShare(top)}\n`)
  }
  return outOfScope()
}
