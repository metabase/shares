// Web app pages to find and manage shares, on the app host (or
// the combined host): the share page /_s/<slug> (attributes, views,
// versions, files of a version, diffs, and the rename, transfer, delete
// and title forms) and the collections page /_collections. D1+R2 store
// only: the KV store has no versions.

import type { Env } from '../env'
import { esc, notFound, page } from '../render/page'
import { STYLE, nav, when } from './shell'
import { contentBase } from '../origins'
import { isQueryStore, StoreError, type QueryStore, type ShareStore } from '../store'
import type { ShareInfo, VersionInfo } from '../api-types'
import { asText, hunks, lineDiff } from './diff'

// one old file shown as text; bigger files show their size only
const MAX_SHOW = 1_000_000
// per diff page: changed files with a line diff, and bytes of each side
const MAX_DIFF_FILES = 50
const MAX_DIFF_BYTES = 512_000

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
  if (!share) return message('Not found', 'No share with that slug.', 404)
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
    .map(([e, x]) => `<tr><td class="w">${esc(e)}</td><td class="r">${x.n}</td><td>${when(x.last)}</td></tr>`)

  const meta = Object.keys(share.meta).length
    ? `<div class="meta"><span>Meta</span><pre>${esc(JSON.stringify(share.meta, null, 2))}</pre></div>` : ''
  const title = share.title || slug
  return page(title, `${STYLE}<div class="app sh">${nav(email, env, 'shares')}
<div class="top"><div><h1 title="${esc(title)}">${esc(title)}</h1>
<p class="slugline">${slugLine(slug, share.collection)}</p></div>
<div class="acts"><button class="sm cp" data-u="${esc(content)}">Copy link</button><a class="btn sm" href="${esc(content)}_zip">Download zip</a><a class="btn pri" href="${esc(content)}">Open</a></div></div>
<dl class="strip">
<div><dt>Owner</dt><dd>${esc(share.owner)}</dd></div>
<div><dt>Collection</dt><dd>${share.collection ? `<a href="/?c=${encodeURIComponent(share.collection)}">${esc(share.collection)}</a>` : '—'}</dd></div>
<div><dt>Live version</dt><dd>v${share.version}, ${share.fileCount} file${share.fileCount === 1 ? '' : 's'}, ${bytes(share.totalBytes)}</dd></div>
<div><dt>Updated</dt><dd>${when(share.updatedAt)}</dd></div>
<div><dt>Created</dt><dd>${when(share.createdAt)}</dd></div>
</dl>
${meta}
${detail}
<h2>Versions</h2>
${versionTable(versions, self)}
${manage ? `<h2>Views</h2>${viewRows.length
    ? `<div class="scroll"><table><tr><th>Viewer</th><th class="r">Views</th><th>Last</th></tr>${viewRows.join('')}</table></div>`
    : '<p class="sub">No views yet.</p>'}
${manageForms(share, self, email, env)}` : ''}
</div>
<script>
document.querySelectorAll('.sh button.cp').forEach(function (b) {
  b.addEventListener('click', function () {
    navigator.clipboard.writeText(new URL(b.getAttribute('data-u'), location.href).href).then(function () {
      b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy link' }, 900)
    })
  })
})
</script>`, { poll: false })
}

// The slug as a path under its collection; the collection part links to
// the collection.
function slugLine(slug: string, collection: string | null) {
  return collection ? `<a href="/?c=${encodeURIComponent(collection)}">${esc(collection)}</a> / ${esc(slug)}` : esc(slug)
}

function versionTable(versions: VersionInfo[], self: string) {
  const done = versions.filter((v) => v.state === 'complete')
  const rows = versions.map((v) => {
    const prev = done.find((p) => p.version < v.version)
    const links = v.state === 'complete'
      ? `<a href="${self}?v=${v.version}">Files</a>${prev ? ` · <a href="${self}?diff=${prev.version}..${v.version}">Diff</a>` : ''}`
      : ''
    return `<tr><td>v${v.version} ${v.live ? '<span class="tag live">live</span>' : ''}${
      v.state === 'pending' ? '<span class="tag">pending</span>' : ''}</td>
<td>${esc(v.createdBy)}</td><td>${when(v.createdAt)}</td>
<td class="r">${v.fileCount}</td><td class="r">${bytes(v.totalBytes)}</td>
<td class="w">${esc(v.message ?? '')}</td><td>${links}</td></tr>`
  })
  return `<div class="scroll"><table><tr><th>Version</th><th>By</th><th>When</th><th class="r">Files</th><th class="r">Size</th><th>Message</th><th></th></tr>${rows.join('')}</table></div>`
}

// files of version v; f: one file of it, as escaped text
async function versionSection(store: QueryStore, share: ShareInfo, self: string, content: string, v: number, f: string | null) {
  const man = Number.isInteger(v) && v > 0 ? await store.shareManifest(share.slug, v) : null
  if (!man) return '<h2>Version</h2><p class="sub">No complete version with that number.</p>'
  const live = v === share.version
  let file = ''
  if (f !== null) {
    const entry = man.files.find((x) => x.path === f)
    if (!entry) file = '<p class="sub">No such file in this version.</p>'
    else {
      const text = entry.size <= MAX_SHOW ? asText(await store.blobBytes(entry.sha256)) : null
      file = `<h2 class="mono">${esc(f)}</h2>${text === null
        ? `<p class="sub">${bytes(entry.size)}, not shown as text.</p>`
        : `<pre><code>${esc(text)}</code></pre>`}`
    }
  }
  const rows = man.files.map((x) => {
    const href = live ? `${content}${x.path.split('/').map(encodeURIComponent).join('/')}`
      : `${self}?v=${v}&f=${encodeURIComponent(x.path)}`
    return `<tr><td class="w mono"><a href="${esc(href)}">${esc(x.path)}</a></td><td class="r">${bytes(x.size)}</td>
<td class="mono" title="${x.sha256}">${x.sha256.slice(0, 10)}</td></tr>`
  })
  return `<h2>Files of v${v}${live ? ' (live)' : ''}</h2>${file}
<div class="scroll"><table><tr><th>Path</th><th class="r">Size</th><th>SHA-256</th></tr>${rows.join('')}</table></div>`
}

async function diffSection(store: QueryStore, slug: string, self: string, a: number, b: number) {
  const [ma, mb] = await Promise.all([store.shareManifest(slug, a), store.shareManifest(slug, b)])
  if (!ma || !mb) return '<h2>Diff</h2><p class="sub">Both sides must be complete versions.</p>'
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
  const more = changed.length > MAX_DIFF_FILES ? `<p class="sub">${changed.length - MAX_DIFF_FILES} more changed files not shown.</p>` : ''
  return `<h2>Diff v${a} → v${b}</h2>
<p class="sub">${changed.length} of ${paths.length} files differ · <a href="${self}?v=${a}">v${a} files</a> · <a href="${self}?v=${b}">v${b} files</a></p>
${blocks.join('\n')}${more}`
}

const fileHead = (p: string, state: string, note?: string) =>
  `<p class="mono"><b>${esc(p)}</b> <span class="tag">${state}</span>${note ? ` <span class="sub">${note}</span>` : ''}</p>`

function manageForms(share: ShareInfo, self: string, email: string, env: Env) {
  const form = (action: string, body: string, cls = '') =>
    `<form method="post" action="${self}"${cls ? ` class="${cls}"` : ''}><input type="hidden" name="action" value="${action}">${body}</form>`
  const lose = email === share.owner && email !== env.ADMIN_EMAIL ? ' You lose edit access.' : ''
  return `<h2>Settings</h2>
<div class="frm">
${form('attrs', `<div class="two"><label>Title<input name="title" value="${esc(share.title ?? '')}" maxlength="500"></label>
<label>Collection<input name="collection" value="${esc(share.collection ?? '')}"></label></div>
<button class="pri">Save</button><p class="hint">An empty field clears the title or the collection.</p>`)}
${form('rename', `<label>Rename slug<input name="to" placeholder="New slug" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*"></label>
<button>Rename</button><p class="hint">Old links stop working.</p>`)}
${form('transfer', `<label>Transfer to<input name="to" type="email" placeholder="New owner email" required></label>
<button>Transfer</button><p class="hint">An @${esc(env.ALLOWED_DOMAIN)} email.${lose}</p>`)}
<p class="dzh">Delete share</p>
${form('delete', `<label>Type the slug to confirm<input name="confirm" placeholder="${esc(share.slug)}" required></label>
<button class="danger">Delete</button><p class="hint">Deletes every version and its files. This cannot be undone.</p>`, 'dz')}
</div>`
}

// POST /_s/<slug>: the forms of the share page. The caller checks the
// session and the Origin.
export async function managePost(req: Request, url: URL, env: Env, store: ShareStore, email: string): Promise<Response> {
  if (!isQueryStore(store)) return notFound()
  const slug = decodeURIComponent(url.pathname.slice('/_s/'.length))
  const share = await store.share(slug)
  if (!share) return message('Not found', 'No share with that slug.', 404)
  if (!canManage(share, email, env)) return message('Forbidden', `Owned by ${esc(share.owner)}.`, 403)
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
          return message('Bad owner', `The new owner must be an @${esc(env.ALLOWED_DOMAIN)} email.`, 400)
        }
        await store.transfer(slug, to, email)
        return back()
      }
      case 'delete':
        if (field('confirm') !== slug) return message('Not deleted', 'The confirmation did not match the slug.', 400)
        await store.deleteShare(slug, email)
        return back('/')
      default:
        return new Response('bad action\n', { status: 400 })
    }
  } catch (e) {
    if (e instanceof StoreError) return message('Not changed', esc(e.message), e.status)
    throw e
  }
}

// GET /_collections
export async function collectionsPage(env: Env, store: ShareStore, email: string) {
  if (!isQueryStore(store)) return notFound()
  const rows = (await store.collections()).map((c) => `<tr><td class="s"><a class="nm" href="/?c=${encodeURIComponent(c.slug)}">${
    c.title ? `<span class="ti">${esc(c.title)}</span>` : ''}<span class="slug">${esc(c.slug)}</span></a></td>
<td class="o">${esc(c.owner.split('@')[0])}</td><td class="n">${c.shares}</td><td class="t">${when(c.updatedAt)}</td></tr>`)
  return page('Collections', `${STYLE}<div class="app">${nav(email, env, 'collections')}<div class="hd"><h1>Collections</h1></div>
<p class="sub">Every collection. Anyone at Metabase can see the shares in a collection.</p>
${rows.length ? `<div class="scroll"><table class="lst"><thead><tr><th>Collection</th><th>Owner</th><th class="r">Shares</th><th>Updated</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<p class="sub">No collections yet.</p>'}</div>`, { poll: false })
}
