// Bearer-token endpoints of the `share` CLI. Request and response shapes:
// api-types.ts.

import type { Env } from '../env'
import { isQueryStore, StoreError } from '../store'
import { pinned } from '../store'
import type { CommitFile, ShareAttrs, ShareStore } from '../store'
import type { ImportRequest, PublishResponse } from '../api-types'
import { contentBase } from '../origins'
import { jsonApi } from './json'

// absolute links on the content host: the share follows the live version,
// the version link stays on this version
export function publishResponse(url: URL, env: Env, slug: string, version: number): PublishResponse {
  const base = contentBase(url, env) || url.origin
  return { slug, version, url: `${base}/${slug}/`, versionUrl: `${base}/${slug}@${version}/` }
}

// a slug a publish, claim or public switch can take: "<slug>@<n>" is a
// version read path, not a share
export const badSlug = (top: string) => !top || top.startsWith('_') || top.includes('/') || !!pinned(top)

// ?collection=C&title=T&meta=k=v...; meta values are JSON strings
function finalizeAttrs(q: URLSearchParams): ShareAttrs | undefined {
  const a: ShareAttrs = {}
  if (q.has('collection')) a.collection = q.get('collection')
  if (q.has('title')) a.title = q.get('title')
  const meta = q.getAll('meta')
  if (meta.length) {
    a.meta = {}
    for (const m of meta) {
      const i = m.indexOf('=')
      if (i < 1) throw new StoreError(400, `bad meta: ${m} (want key=value)`)
      a.meta[m.slice(0, i)] = m.slice(i + 1)
    }
  }
  return Object.keys(a).length ? a : undefined
}

const lines = (xs: string[]) => new Response(xs.join('\n') + (xs.length ? '\n' : ''))

export async function cli(req: Request, url: URL, env: Env, store: ShareStore, who: string): Promise<Response> {
  try {
    return await dispatch(req, url, env, store, who)
  } catch (e) {
    if (e instanceof StoreError) return new Response(`${e.message}\n`, { status: e.status })
    throw e
  }
}

async function dispatch(req: Request, url: URL, env: Env, store: ShareStore, who: string): Promise<Response> {
  const admin = who === env.ADMIN_EMAIL

  if (url.pathname === '/_list') {
    // ?prefix=slug/ lists every file in a share (any token -- download works
    // on anything you can view); bare _list lists your own share slugs
    const prefix = url.searchParams.get('prefix')
    if (prefix?.startsWith('_')) return new Response('reserved\n', { status: 400 })
    if (prefix) return lines(await store.filesUnder(prefix))
    return lines([...await store.shares()]
      .filter(([, s]) => admin || (s.o || env.ADMIN_EMAIL) === who)
      .map(([top]) => top).sort())
  }

  // POST /_migrate (admin): rebuild every manifest + owner from a full
  // sweep. One-time bootstrap for pre-manifest shares.
  if (url.pathname === '/_migrate') {
    if (!admin) return new Response('forbidden', { status: 403 })
    return new Response(`migrated ${await store.rebuildAll()}\n`)
  }

  const key = decodeURIComponent(url.pathname.slice(1))
  if (!key) return new Response('missing key', { status: 400 })

  if (key === '_api' || key.startsWith('_api/')) return jsonApi(req, url, key, env, store, who)

  // Versioned publish (D1+R2 store): upload the blobs the store lacks, then
  // commit one manifest. The previous version stays live until the commit.
  if (key.startsWith('_blobs/') || key.startsWith('_publish/')) {
    if (!store.missingBlobs || !store.putBlob || !store.commit) {
      return new Response('not supported\n', { status: 501 })
    }
    if (key === '_blobs/missing' && req.method === 'POST') {
      return lines(await store.missingBlobs((await req.text()).split('\n').map((s) => s.trim()).filter(Boolean)))
    }
    if (key.startsWith('_blobs/') && req.method === 'PUT') {
      await store.putBlob(key.slice('_blobs/'.length), await req.arrayBuffer())
      return new Response('ok\n')
    }
    if (key.startsWith('_publish/') && req.method === 'POST') {
      const top = key.slice('_publish/'.length).replace(/\/$/, '')
      if (badSlug(top)) return new Response('bad slug\n', { status: 400 })
      const owner = await store.owner(top)
      if (owner && owner !== who && !admin) {
        return new Response(`owned by ${owner}\n`, { status: 403 })
      }
      let body: { files?: CommitFile[]; message?: string } & ShareAttrs
      try { body = await req.json() } catch { return new Response('bad json\n', { status: 400 }) }
      if (!Array.isArray(body.files)) return new Response('files missing\n', { status: 400 })
      const { title, collection, meta } = body
      const version = await store.commit(top, body.files, who, body.message, { title, collection, meta })
      return Response.json(publishResponse(url, env, top, version))
    }
    return new Response('not found\n', { status: 404 })
  }

  // POST /_import/<slug> (admin): one share of the mb-shares KV export
  // (SHR-10, scripts/kv-import.ts). The slug is kept as it was.
  if (key.startsWith('_import/') && req.method === 'POST') {
    if (!admin) return new Response('forbidden', { status: 403 })
    if (!store.importShare) return new Response('not supported\n', { status: 501 })
    const top = key.slice('_import/'.length).replace(/\/$/, '')
    if (badSlug(top)) return new Response('bad slug\n', { status: 400 })
    let body: ImportRequest
    try { body = await req.json() } catch { return new Response('bad json\n', { status: 400 }) }
    return Response.json(await store.importShare(top, body, who))
  }

  // POST /_public/<slug>, body "on" or "off" (SHR-9). Only the owner makes
  // a share public; the owner or admin makes it private again. "on" is
  // refused while PUBLIC_SHARING is off. Each change is audit logged.
  if (key.startsWith('_public/') && req.method === 'POST') {
    const top = key.slice('_public/'.length).replace(/\/$/, '')
    if (badSlug(top)) return new Response('bad slug\n', { status: 400 })
    const v = (await req.text()).trim()
    if (v !== 'on' && v !== 'off') return new Response('body must be on or off\n', { status: 400 })
    if (!store.setPublic) return new Response('not supported\n', { status: 501 })
    if (v === 'on' && env.PUBLIC_SHARING !== '1') {
      return new Response('public sharing is disabled\n', { status: 403 })
    }
    const owner = await store.owner(top)
    if (!owner) return new Response('not found\n', { status: 404 })
    if (owner !== who && !(admin && v === 'off')) {
      return new Response(`owned by ${owner}\n`, { status: 403 })
    }
    await store.setPublic(top, v === 'on', who)
    return new Response(`${v}\n`)
  }

  // GET /_audit (admin): newest audit rows, tab-separated ISO time, actor,
  // action, share
  if (key === '_audit' && req.method === 'GET') {
    if (!admin) return new Response('forbidden', { status: 403 })
    if (!store.audit) return new Response('not supported\n', { status: 501 })
    const n = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    return lines((await store.audit(n)).map((a) =>
      `${new Date(a.at).toISOString()}\t${a.actor}\t${a.action}\t${a.share ?? ''}`))
  }

  // POST /_finalize/<slug>, body = newline-separated relative paths the CLI
  // just uploaded: writes the manifest without any list(). Owner-gated like
  // other writes; worst case an owner mis-lists their own share.
  if (key.startsWith('_finalize/')) {
    const top = key.slice('_finalize/'.length).replace(/\/$/, '')
    if (!top || top.startsWith('_') || pinned(top)) return new Response('bad slug\n', { status: 400 })
    const owner = await store.owner(top)
    if (owner && owner !== who && !admin) {
      return new Response(`owned by ${owner}\n`, { status: 403 })
    }
    const files = (await req.text()).split('\n').map((s) => s.trim()).filter(Boolean)
    if (!files.length) return new Response('empty manifest\n', { status: 400 })
    const attrs = finalizeAttrs(url.searchParams)
    if (attrs && !isQueryStore(store)) return new Response('attributes not supported\n', { status: 501 })
    await store.finalize(top, files, owner || who, who, attrs)
    // push counter for /_stats: one finalize = one push
    await store.countPush(who)
    return new Response('ok\n')
  }

  // _-prefixed top segments are reserved (store bookkeeping and the
  // _list/_token/_stats/_cli/_peek/_zip/_views/_public/_audit/_import routes). Reads AND writes: a
  // PUT to /_own/<slug> could hijack ownership on the KV store, a GET/list
  // under _own/ would enumerate every slug (share URLs are meant to be
  // unguessable).
  if (key.startsWith('_')) return new Response('reserved\n', { status: 400 })

  // GET /slug/_views: who viewed this share (owner or admin only)
  if (req.method === 'GET' && key.endsWith('/_views')) {
    const top = key.slice(0, -'/_views'.length)
    const owner = await store.owner(top)
    if (owner && owner !== who && !admin) {
      return new Response(`owned by ${owner}\n`, { status: 403 })
    }
    const v = (await store.views(top)) || {}
    return lines(Object.entries(v).sort((a, b) => b[1].last - a[1].last)
      .map(([e, x]) => `${e}\t${x.n}\t${new Date(x.last).toISOString()}`))
  }

  if (req.method === 'GET') {
    const body = await store.getStream(key)
    if (body === null) return new Response('not found', { status: 404 })
    return new Response(body)
  }

  // Writes only touch your own shares (admin can touch anything). A slug
  // without an owner is unclaimed; the first PUT claims it. Racers on the
  // same fresh slug are moot: random suffixes.
  const top = key.replace(/\/.*$/, '')
  if (pinned(top)) return new Response('a version is read only\n', { status: 400 })
  const owner = await store.owner(top)

  if (owner && owner !== who && !admin) {
    return new Response(`owned by ${owner}\n`, { status: 403 })
  }

  if (req.method === 'PUT') {
    if (!owner) await store.claim(top, who)
    await store.putFile(key, await req.arrayBuffer(), who)
    return new Response('ok\n')
  }

  // DELETE /name/ removes the whole share, plus bookkeeping. Always by
  // `top`, never the raw key: the owner check above only covers `top`.
  return new Response(`deleted ${await store.deleteShare(top, who)}\n`)
}
