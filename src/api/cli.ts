// Bearer-token endpoints of the `share` CLI. Request and response shapes:
// api-types.ts.

import CLI_SH from '../../bin/share' // text module (wrangler.toml rules), served at /_cli
import SKILL_MD from '../../skill/SKILL.md' // ditto, served at /_skill
import type { Env } from '../env'
import type { ShareStore } from '../store'

const lines = (xs: string[]) => new Response(xs.join('\n') + (xs.length ? '\n' : ''))

export async function cli(req: Request, url: URL, env: Env, store: ShareStore, who: string): Promise<Response> {
  const admin = who === env.ADMIN_EMAIL

  // the share script + Claude Code skill, for one-line installs from /_token
  if (url.pathname === '/_cli') return new Response(CLI_SH)
  if (url.pathname === '/_skill') return new Response(SKILL_MD)

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

  // POST /_finalize/<slug>, body = newline-separated relative paths the CLI
  // just uploaded: writes the manifest without any list(). Owner-gated like
  // other writes; worst case an owner mis-lists their own share.
  if (key.startsWith('_finalize/')) {
    const top = key.slice('_finalize/'.length).replace(/\/$/, '')
    if (!top || top.startsWith('_')) return new Response('bad slug\n', { status: 400 })
    const owner = await store.owner(top)
    if (owner && owner !== who && !admin) {
      return new Response(`owned by ${owner}\n`, { status: 403 })
    }
    const files = (await req.text()).split('\n').map((s) => s.trim()).filter(Boolean)
    if (!files.length) return new Response('empty manifest\n', { status: 400 })
    await store.finalize(top, files, owner || who)
    // push counter for /_stats: one finalize = one push
    await store.countPush(who)
    return new Response('ok\n')
  }

  // _-prefixed top segments are reserved (store bookkeeping and the
  // _list/_token/_stats/_cli/_peek/_zip/_views routes). Reads AND writes: a
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
  return new Response(`deleted ${await store.deleteShare(top)}\n`)
}
