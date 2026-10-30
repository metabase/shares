// Web app pages to find and manage shares, on the app host (or
// the combined host): the share page /_s/<slug> (attributes, views,
// versions, files of a version, diffs, and the rename, transfer, delete
// and title forms) and the collections page /_collections. D1+R2 store
// only: the KV store has no versions.

import type { Env } from '../env'
import { ago, esc, notFound, page } from '../render/page'
import { contentBase } from '../origins'
import { isQueryStore, StoreError, type QueryStore, type ShareStore } from '../store'
import type { ShareInfo, VersionInfo } from '../api-types'
import { asText, hunks, lineDiff } from './diff'

// one old file shown as text; bigger files show their size only
const MAX_SHOW = 1_000_000
// per diff page: changed files with a line diff, and bytes of each side
const MAX_DIFF_FILES = 50
const MAX_DIFF_BYTES = 512_000

export const STYLE = `<style>
  .app h1{margin:0;font-size:1.3rem;overflow-wrap:anywhere}
  .app h2{font-size:1rem;margin:1.5rem 0 .4rem}
  .app .sub{color:var(--muted);margin:.25rem 0 1rem;font-size:.85rem}
  nav.top{font-size:.85rem;margin:0 0 1rem;color:var(--muted)}
  nav.top a{text-decoration:none;margin-right:.9em}
  nav.top a:hover{text-decoration:underline}
  nav.top .me{float:right}
  .app table{display:table;width:100%;min-width:0;max-width:none;left:auto;transform:none;
    background:none;padding:0;font-size:.85rem;border-collapse:collapse}
  .app th{text-align:left;color:var(--muted);font-weight:normal}
  .app td,.app th{border:0;border-bottom:1px solid var(--border);padding:.3em .4em;white-space:nowrap;
    vertical-align:top}
  .app td.w{width:100%;white-space:normal;overflow-wrap:anywhere}
  .app td.r{text-align:right}
  .app .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
  .app dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem;font-size:.85rem;margin:0}
  .app dt{color:var(--muted)}
  .app dd{margin:0;overflow-wrap:anywhere}
  .app pre{width:100%;min-width:0;max-width:none;left:0;transform:none;box-sizing:border-box;
    margin:.4rem 0 0;font-size:.78rem;white-space:pre-wrap;overflow-wrap:anywhere}
  .app .d-add{background:rgba(46,160,67,.18)}
  .app .d-del{background:rgba(248,81,73,.18)}
  .app .d-gap{color:var(--muted)}
  .app .tag{font-size:.7rem;border:1px solid var(--border);border-radius:5px;padding:0 .35em;color:var(--muted)}
  .app .tag.live{color:var(--acc2);border-color:var(--acc2)}
  .app form{margin:.5rem 0}
  .app button,.app input{font:inherit;font-size:.8rem}
  .app button{color:var(--fg);background:none;border:1px solid var(--border);border-radius:5px;
    padding:.1em .6em;cursor:pointer}
  .app button:hover{border-color:var(--muted)}
  .app button.danger{color:#f85149;border-color:#f85149}
  .app input{background:var(--code-bg);color:var(--fg);border:1px solid var(--border);border-radius:5px;
    padding:.15em .5em}
  .app .box{border:1px solid var(--border);border-radius:10px;padding:.5rem 1rem;margin:1rem 0}
  .app .box p{margin:.3rem 0;font-size:.8rem;color:var(--muted)}
</style>`

// links of every app page
export function nav(email: string, env: Env) {
  return `<nav class="top"><a href="/">shares</a><a href="/_collections">collections</a><a href="/_token">cli tokens</a>${
    email === env.ADMIN_EMAIL ? '<a href="/_stats">stats</a>' : ''}<span class="me">${esc(email)}</span></nav>`
}

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

const canManage = (share: ShareInfo, email: string, env: Env) => share.owner === email || email === env.ADMIN_EMAIL

export function message(title: string, html: string, status: number) {
  const r = page(title, `${STYLE}<div class="app"><h1>${esc(title)}</h1><p class="sub">${html}</p></div>`, { poll: false })
  return new Response(r.body, { status, headers: r.headers })
}

// GET /_s/<slug>[?v=N[&f=PATH] | ?diff=A..B]
export async function sharePage(url: URL, env: Env, store: ShareStore, email: string, slug: string) {
  if (!isQueryStore(store)) return notFound()
  const share = await store.share(slug)
  if (!share) return message('not found', 'no share with that slug.', 404)
  const versions = await store.versions(slug)
  const q = url.searchParams
  const self = `/_s/${encodeURIComponent(slug)}`
  const content = `${contentBase(url, env)}/${encodeURIComponent(slug)}/`

  let detail = ''
  const diff = q.get('diff')?.match(/^(\d+)\.\.(\d+)$/)
  if (diff) detail = await diffSection(store, slug, self, Number(diff[1]), Number(diff[2]))
  else if (q.has('v')) detail = await versionSection(store, share, self, content, Number(q.get('v')), q.get('f'))

  const manage = canManage(share, email, env)
  const views = manage ? await store.views(slug) : null
  const viewRows = Object.entries(views ?? {}).sort((a, b) => b[1].last - a[1].last)
    .map(([e, x]) => `<tr><td class="w">${esc(e)}</td><td class="r">${x.n}</td><td>${ago(x.last)}</td></tr>`)

  return page(share.title || slug, `${STYLE}<div class="app">${nav(email, env)}
<h1>${esc(share.title || slug)}</h1>
<p class="sub"><span class="mono">${esc(slug)}</span> · <a href="${esc(content)}">open</a> · <a href="${esc(content)}_zip">zip</a></p>
<dl>
<dt>owner</dt><dd>${esc(share.owner)}</dd>
<dt>collection</dt><dd>${share.collection ? `<a href="/?c=${encodeURIComponent(share.collection)}">${esc(share.collection)}</a>` : '—'}</dd>
<dt>live version</dt><dd>v${share.version}, ${share.fileCount} file${share.fileCount === 1 ? '' : 's'}, ${bytes(share.totalBytes)}</dd>
<dt>updated</dt><dd title="${new Date(share.updatedAt).toISOString()}">${ago(share.updatedAt)}</dd>
<dt>created</dt><dd title="${new Date(share.createdAt).toISOString()}">${ago(share.createdAt)}</dd>
${Object.keys(share.meta).length ? `<dt>meta</dt><dd><pre>${esc(JSON.stringify(share.meta, null, 2))}</pre></dd>` : ''}
</dl>
${detail}
<h2>versions</h2>
${versionTable(versions, self)}
${manage ? `<h2>views</h2>${viewRows.length
    ? `<table><tr><th>viewer</th><th class="r">views</th><th>last</th></tr>${viewRows.join('')}</table>`
    : '<p class="sub">no views yet</p>'}
${manageForms(share, self)}` : ''}
</div>`, { poll: false })
}

function versionTable(versions: VersionInfo[], self: string) {
  const done = versions.filter((v) => v.state === 'complete')
  const rows = versions.map((v) => {
    const prev = done.find((p) => p.version < v.version)
    const links = v.state === 'complete'
      ? `<a href="${self}?v=${v.version}">files</a>${prev ? ` · <a href="${self}?diff=${prev.version}..${v.version}">diff</a>` : ''}`
      : ''
    return `<tr><td>v${v.version} ${v.live ? '<span class="tag live">live</span>' : ''}${
      v.state === 'pending' ? '<span class="tag">pending</span>' : ''}</td>
<td>${esc(v.createdBy)}</td><td title="${new Date(v.createdAt).toISOString()}">${ago(v.createdAt)}</td>
<td class="r">${v.fileCount}</td><td class="r">${bytes(v.totalBytes)}</td>
<td class="w">${esc(v.message ?? '')}</td><td>${links}</td></tr>`
  })
  return `<table><tr><th>version</th><th>by</th><th>when</th><th class="r">files</th><th class="r">size</th><th>message</th><th></th></tr>${rows.join('')}</table>`
}

// files of version v; f: one file of it, as escaped text
async function versionSection(store: QueryStore, share: ShareInfo, self: string, content: string, v: number, f: string | null) {
  const man = Number.isInteger(v) && v > 0 ? await store.shareManifest(share.slug, v) : null
  if (!man) return '<h2>version</h2><p class="sub">no complete version with that number</p>'
  const live = v === share.version
  let file = ''
  if (f !== null) {
    const entry = man.files.find((x) => x.path === f)
    if (!entry) file = '<p class="sub">no such file in this version</p>'
    else {
      const text = entry.size <= MAX_SHOW ? asText(await store.blobBytes(entry.sha256)) : null
      file = `<h2 class="mono">${esc(f)}</h2>${text === null
        ? `<p class="sub">${bytes(entry.size)}, not shown as text</p>`
        : `<pre><code>${esc(text)}</code></pre>`}`
    }
  }
  const rows = man.files.map((x) => {
    const href = live ? `${content}${x.path.split('/').map(encodeURIComponent).join('/')}`
      : `${self}?v=${v}&f=${encodeURIComponent(x.path)}`
    return `<tr><td class="w mono"><a href="${esc(href)}">${esc(x.path)}</a></td><td class="r">${bytes(x.size)}</td>
<td class="mono" title="${x.sha256}">${x.sha256.slice(0, 10)}</td></tr>`
  })
  return `<h2>files of v${v}${live ? ' (live)' : ''}</h2>${file}
<table><tr><th>path</th><th class="r">size</th><th>sha256</th></tr>${rows.join('')}</table>`
}

async function diffSection(store: QueryStore, slug: string, self: string, a: number, b: number) {
  const [ma, mb] = await Promise.all([store.shareManifest(slug, a), store.shareManifest(slug, b)])
  if (!ma || !mb) return '<h2>diff</h2><p class="sub">both sides must be complete versions</p>'
  const before = new Map(ma.files.map((f) => [f.path, f]))
  const after = new Map(mb.files.map((f) => [f.path, f]))
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  const changed = paths.filter((p) => before.get(p)?.sha256 !== after.get(p)?.sha256)
  const state = (p: string) => !before.has(p) ? 'added' : !after.has(p) ? 'removed' : 'changed'

  const blocks: string[] = []
  for (const p of changed.slice(0, MAX_DIFF_FILES)) {
    const x = before.get(p)
    const y = after.get(p)
    if ((x?.size ?? 0) > MAX_DIFF_BYTES || (y?.size ?? 0) > MAX_DIFF_BYTES) {
      blocks.push(fileHead(p, state(p), 'too large for a line diff'))
      continue
    }
    const [tx, ty] = await Promise.all([
      x ? store.blobBytes(x.sha256).then(asText) : '',
      y ? store.blobBytes(y.sha256).then(asText) : '',
    ])
    const ops = tx === null || ty === null ? null : lineDiff(tx, ty)
    if (!ops) {
      blocks.push(fileHead(p, state(p), tx === null || ty === null ? 'binary' : 'too large for a line diff'))
      continue
    }
    const lines = hunks(ops).map((o) => o === null
      ? '<span class="d-gap">…</span>'
      : `<span${o.t === '+' ? ' class="d-add"' : o.t === '-' ? ' class="d-del"' : ''}>${o.t} ${esc(o.s)}</span>`)
    blocks.push(`${fileHead(p, state(p))}<pre><code>${lines.join('\n')}</code></pre>`)
  }
  const more = changed.length > MAX_DIFF_FILES ? `<p class="sub">${changed.length - MAX_DIFF_FILES} more changed files not shown</p>` : ''
  return `<h2>diff v${a} → v${b}</h2>
<p class="sub">${changed.length} of ${paths.length} files differ · <a href="${self}?v=${a}">v${a} files</a> · <a href="${self}?v=${b}">v${b} files</a></p>
${blocks.join('\n')}${more}`
}

const fileHead = (p: string, state: string, note?: string) =>
  `<p class="mono"><b>${esc(p)}</b> <span class="tag">${state}</span>${note ? ` <span class="sub">${note}</span>` : ''}</p>`

function manageForms(share: ShareInfo, self: string) {
  const hidden = (a: string) => `<input type="hidden" name="action" value="${a}">`
  return `<h2>manage</h2>
<div class="box"><form method="post" action="${self}">${hidden('attrs')}
<input name="title" placeholder="title" value="${esc(share.title ?? '')}" maxlength="500" size="30">
<input name="collection" placeholder="collection" value="${esc(share.collection ?? '')}" size="24">
<button>save</button></form>
<p>empty fields clear the title or the collection</p></div>
<div class="box"><form method="post" action="${self}">${hidden('rename')}
<input name="to" placeholder="new slug" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*"> <button>rename</button></form>
<p>the old link stops working</p></div>
<div class="box"><form method="post" action="${self}">${hidden('transfer')}
<input name="to" type="email" placeholder="new owner email" required> <button>transfer</button></form>
<p>the new owner can then change and delete the share</p></div>
<div class="box"><form method="post" action="${self}">${hidden('delete')}
<input name="confirm" placeholder="type ${esc(share.slug)}" required> <button class="danger">delete</button></form>
<p>removes every version and its files; this cannot be undone</p></div>`
}

// POST /_s/<slug>: the forms of the share page. The caller checks the
// session and the Origin.
export async function managePost(req: Request, url: URL, env: Env, store: ShareStore, email: string): Promise<Response> {
  if (!isQueryStore(store)) return notFound()
  const slug = decodeURIComponent(url.pathname.slice('/_s/'.length))
  const share = await store.share(slug)
  if (!share) return message('not found', 'no share with that slug.', 404)
  if (!canManage(share, email, env)) return message('forbidden', `owned by ${esc(share.owner)}.`, 403)
  let form: FormData
  try { form = await req.formData() } catch { return new Response('bad form\n', { status: 400 }) }
  const field = (k: string) => String(form.get(k) ?? '').trim()
  const back = (to = `/_s/${encodeURIComponent(slug)}`) => new Response(null, { status: 303, headers: { location: to } })

  try {
    switch (field('action')) {
      case 'attrs':
        await store.setAttrs(slug, { title: field('title') || null, collection: field('collection') || null }, email)
        return back()
      case 'rename': {
        const to = field('to')
        await store.rename(slug, to, email)
        return back(`/_s/${encodeURIComponent(to)}`)
      }
      case 'transfer': {
        const to = field('to').toLowerCase()
        if (!/^[^@\s]+@[^@\s]+$/.test(to) || !to.endsWith(`@${env.ALLOWED_DOMAIN}`)) {
          return message('bad owner', `the new owner must be an @${esc(env.ALLOWED_DOMAIN)} email.`, 400)
        }
        await store.transfer(slug, to, email)
        return back()
      }
      case 'delete':
        if (field('confirm') !== slug) return message('not deleted', 'the confirmation did not match the slug.', 400)
        await store.deleteShare(slug, email)
        return back('/')
      default:
        return new Response('bad action\n', { status: 400 })
    }
  } catch (e) {
    if (e instanceof StoreError) return message('not changed', esc(e.message), e.status)
    throw e
  }
}

// GET /_collections
export async function collectionsPage(env: Env, store: ShareStore, email: string) {
  if (!isQueryStore(store)) return notFound()
  const rows = (await store.collections()).map((c) => `<tr><td class="w mono"><a href="/?c=${encodeURIComponent(c.slug)}">${esc(c.slug)}</a>${
    c.title ? ` <span class="sub">${esc(c.title)}</span>` : ''}</td><td>${esc(c.owner.split('@')[0])}</td>
<td class="r">${c.shares}</td><td title="${new Date(c.updatedAt).toISOString()}">${ago(c.updatedAt)}</td></tr>`)
  return page('collections', `${STYLE}<div class="app">${nav(email, env)}<h1>collections</h1>
<p class="sub">every collection; a collection lists its shares to every signed-in user</p>
${rows.length ? `<table><tr><th>collection</th><th>owner</th><th class="r">shares</th><th>updated</th></tr>${rows.join('')}</table>`
    : '<p class="sub">no collections yet</p>'}</div>`, { poll: false })
}
