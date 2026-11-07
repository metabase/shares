// JSON query API under /_api/ (bearer token): collections, share
// attributes, versions and manifests. Shapes: api-types.ts.

import type { Env } from '../env'
import { canRead, isQueryStore, StoreError } from '../store'
import type { ShareAttrs, ShareStore } from '../store'

const error = (status: number, message: string) => Response.json({ error: message }, { status })

// the store checks the shape
async function body<T>(req: Request) {
  try { return await req.json() as T } catch { throw new StoreError(400, 'bad json') }
}

export async function jsonApi(req: Request, url: URL, key: string, env: Env, store: ShareStore, who: string): Promise<Response> {
  if (!isQueryStore(store)) return error(501, 'not supported')
  const admin = who === env.ADMIN_EMAIL
  const get = req.method === 'GET'
  const [, kind, ...rest] = key.split('/')
  try {
    if (kind === 'collections') {
      const slug = rest.join('/')
      if (!slug) return get ? Response.json(await store.collections(url.searchParams.get('prefix') ?? '', who)) : error(405, 'method not allowed')
      const c = await store.collection(slug, who)
      if (get) return c ? Response.json(c) : error(404, 'not found')
      if (req.method !== 'PUT') return error(405, 'method not allowed')
      if (c && c.owner !== who && !admin) return error(403, `owned by ${c.owner}`)
      return Response.json(await store.putCollection(slug, await body(req), who))
    }

    if (kind === 'shares' && !rest.length) {
      if (!get) return error(405, 'method not allowed')
      const q = url.searchParams
      const collection = q.get('collection') ?? undefined
      let owner = q.get('owner') ?? undefined
      // shares outside a collection are listed to their owner only: share
      // URLs are meant to be unguessable
      if (!collection && !admin) {
        if (owner && owner !== who) return error(403, 'other owners: give a collection')
        owner = who
      }
      const limit = Number(q.get('limit') ?? 100)
      const before = q.has('before') ? Number(q.get('before')) : undefined
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return error(400, 'bad limit: 1 to 1000')
      if (before !== undefined && !Number.isFinite(before)) return error(400, 'bad before')
      const meta: Record<string, string> = {}
      for (const [k, v] of q) if (k.startsWith('meta.')) meta[k.slice('meta.'.length)] = v
      return Response.json(await store.queryShares({ collection, owner, meta, viewer: who, limit, before }))
    }

    if (kind === 'shares') {
      const [slug, sub, ...extra] = rest
      if (extra.length || slug.startsWith('_')) return error(404, 'not found')
      // admin has no read exemption: a private share of another owner is
      // a slug without a share
      const share = await store.share(slug)
      if (!share || !canRead(share, who)) return error(404, 'not found')
      if (sub === undefined && req.method === 'POST') {
        if (share.owner !== who && !admin) return error(403, `owned by ${share.owner}`)
        const attrs = await body<ShareAttrs>(req)
        // admin changes the visibility of another owner's share only from
        // public to org
        if (share.owner !== who && attrs?.visibility !== undefined && attrs.visibility !== 'org') {
          return error(403, 'only the owner sets this visibility')
        }
        await store.setAttrs(slug, attrs, who)
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
    }
    return error(404, 'not found')
  } catch (e) {
    if (e instanceof StoreError) return error(e.status, e.message)
    throw e
  }
}
