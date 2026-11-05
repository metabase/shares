// Web app pages to find and manage shares, on the app host (or
// the combined host): the share page /_s/<slug> (attributes, views,
// versions, files of a version, diffs, and the rename, transfer, delete
// and title forms) and the collections page /_collections. D1+R2 store
// only: the KV store has no versions.

import type { Env } from '../env'
import { esc, notFound, page } from '../render/page'
import { ICON, STYLE, copyLink, iconLink, nav, person, when } from './shell'
import { contentBase } from '../origins'
import { isQueryStore, StoreError, type QueryStore, type ShareStore } from '../store'
import type { Collection, ShareInfo, VersionInfo } from '../api-types'
import { asText, hunks, lineDiff } from './diff'
import { uploadToken, uploadUi } from './upload'

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
  const collections = manage ? await store.collections() : []
  const viewRows = Object.entries(views ?? {}).sort((a, b) => b[1].last - a[1].last)
    .map(([e, x]) => `<tr><td class="w">${person(e, true)}</td><td class="r">${x.n}</td><td>${when(x.last)}</td></tr>`)

  const meta = Object.keys(share.meta).length
    ? `<div class="meta"><span>Meta</span><pre>${esc(JSON.stringify(share.meta, null, 2))}</pre></div>` : ''
  const title = share.title || slug
  return page(title, `${STYLE}<div class="app sh">${nav(email, env, 'shares')}${q.has('moved') ? movedNotice(share.collection) : ''}${q.has('published') ? publishedNotice(q.get('published'), content) : ''}
<div class="top"><div><h1 title="${esc(title)}">${esc(title)}</h1>
<p class="slugline">${slugLine(slug, share.collection)}</p></div>
<div class="acts">${manage && store.commit ? uploadUi({ token: await uploadToken(env, email), mode: 'version', slug }) : ''}${copyLink(content)}${iconLink(`${content}_zip`, 'download', 'Download zip')}<a class="btn pri" href="${esc(content)}">Open</a></div></div>
<dl class="strip">
<div><dt>Owner</dt><dd>${person(share.owner, true)}</dd></div>
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
${manageForms(share, self, email, env, collections)}` : ''}
</div>
`, { poll: false })
}

// after an upload from the web app: the new version and its link
function publishedNotice(v: string | null, content: string) {
  const n = Number(v)
  return `<div class="moved mvrow" data-pub="${Number.isInteger(n) ? n : ''}"><span>Published${Number.isInteger(n) && n > 0 ? ` v${n}` : ''}.</span>
<span class="chip">${esc(content)}</span>${copyLink(content)}</div>
<script>appToast('Published' + (document.querySelector('[data-pub]').dataset.pub ? ' v' + document.querySelector('[data-pub]').dataset.pub : ''), 2500)</script>`
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
      v.state === 'pending' ? '<span class="tag pending">pending</span>' : ''}</td>
<td>${person(v.createdBy, true)}</td><td>${when(v.createdAt)}</td>
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
  `<p class="mono"><b>${esc(p)}</b> <span class="tag ${state}">${state}</span>${note ? ` <span class="sub">${note}</span>` : ''}</p>`

// The notice after a move: a toast, or an inline line without JS. The
// script also takes ?moved off the address.
function movedNotice(collection: string | null) {
  const msg = collection ? `Moved to ${collection}` : 'Removed from its collection'
  return `<noscript><p class="moved" role="status">${esc(msg)}</p></noscript>
<script>appToast(${JSON.stringify(msg).replace(/</g, '\\u003c')}, 3000);history.replaceState(null, '', location.pathname)</script>`
}

function manageForms(share: ShareInfo, self: string, email: string, env: Env, collections: Collection[]) {
  const form = (action: string, body: string, cls = '') =>
    `<form method="post" action="${self}"${cls ? ` class="${cls}"` : ''}><input type="hidden" name="action" value="${action}">${body}</form>`
  const lose = email === share.owner && email !== env.ADMIN_EMAIL ? ' You lose edit access.' : ''
  return `<h2>Settings</h2>
<div class="frm">
${form('title', `<label>Title<input name="title" value="${esc(share.title ?? '')}" maxlength="500" placeholder="${esc(share.slug)}"></label>
<button class="pri">Save</button><p class="hint">An empty title shows the slug.</p>`)}
${movePicker(share, self, collections)}
${form('rename', `<label>Rename slug<input name="to" placeholder="New slug" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*"></label>
<button>Rename</button><p class="hint">Old links stop working.</p>`)}
${form('transfer', `<label>Transfer to<input name="to" type="email" placeholder="New owner email" required></label>
<button>Transfer</button><p class="hint">An @${esc(env.ALLOWED_DOMAIN)} email.${lose}</p>`)}
<p class="dzh">Delete share</p>
${form('delete', `<label>Type the slug to confirm<input name="confirm" placeholder="${esc(share.slug)}" required></label>
<button class="danger">Delete</button><p class="hint">Deletes every version and its files. This cannot be undone.</p>`, 'dz')}
</div>`
}

// The collection of the share as a path chip with a Move button. Move
// opens a dialog: a filter on top, then the collections, "No collection",
// and "Create <path>" for a new valid path. Each choice posts the move
// action. Without JS, a select and a new-path field post the same action.
function movePicker(share: ShareInfo, self: string, collections: Collection[]) {
  const cur = share.collection
  const opt = (c: Collection, i: number) => {
    const here = c.slug === cur
    return `<button id="mvo${i}" role="option" name="collection" value="${esc(c.slug)}"${here ? ' disabled aria-disabled="true"' : ''}
 data-k="${esc(`${c.slug} ${c.title ?? ''}`.trim().toLowerCase())}"><span class="p">${esc(c.slug)}</span>${
      c.title ? `<span class="t">${esc(c.title)}</span>` : ''}<span class="n">${c.shares} share${c.shares === 1 ? '' : 's'}</span>${
      here ? '<span class="tag">current</span>' : ''}</button>`
  }
  const options = collections.map((c) => `<option value="${esc(c.slug)}"${c.slug === cur ? ' selected' : ''}>${esc(c.slug)}</option>`).join('')
  return `<div class="mv" id="mv">
<div class="mvrow"><span class="lbl">Collection</span><span class="chip${cur ? '' : ' none'}">${cur ? esc(cur) : 'No collection'}</span>
<button type="button" class="mvb" aria-haspopup="dialog">Move</button></div>
<form method="post" action="${self}" class="mvf"><input type="hidden" name="action" value="move">
<label>Move to<select name="collection"><option value=""${cur ? '' : ' selected'}>No collection</option>${options}</select></label>
<label>Or a new path<input name="new" placeholder="team/project"></label>
<button>Move</button><p class="hint">A new path makes a new collection: 1 to 4 parts split by /.</p></form>
<dialog class="pick" aria-label="Move to a collection">
<form method="post" action="${self}"><input type="hidden" name="action" value="move">
<div class="ph"><input class="flt" type="text" autocomplete="off" spellcheck="false" placeholder="Filter, or type a new path"
 role="combobox" aria-expanded="true" aria-controls="mvl" aria-label="Filter collections, or type a new path">
<button type="button" class="ic x" aria-label="Close" title="Close">${ICON.x}</button></div>
<div id="mvl" class="opts" role="listbox" aria-label="Collections">
${collections.map(opt).join('\n')}
<button id="mvnone" role="option" name="collection" value="" class="none" data-k=""${cur ? '' : ' disabled aria-disabled="true"'}><span class="p">No collection</span>${
    cur ? '' : '<span class="tag">current</span>'}</button>
<button id="mvnew" role="option" name="collection" value="" class="new" hidden>Create <span class="p"></span></button>
</div>
<p class="hint" id="mvh" aria-live="polite"></p>
</form></dialog>
</div>
<script>
(function () {
  var root = document.getElementById('mv'), d = root.querySelector('dialog'), f = d.querySelector('.flt')
  var all = [].slice.call(d.querySelectorAll('[role=option]')), add = d.querySelector('#mvnew'), hint = d.querySelector('#mvh')
  var paths = all.filter(function (b) { return b !== add }).map(function (b) { return b.value })
  var rule = /^[a-z0-9][a-z0-9._-]{0,63}(\\/[a-z0-9][a-z0-9._-]{0,63}){0,3}$/, act = null
  root.classList.add('js')
  function shown() { return all.filter(function (b) { return !b.hidden && !b.disabled }) }
  function mark(b) {
    if (act) act.classList.remove('on')
    act = b || null
    if (act) { act.classList.add('on'); act.scrollIntoView({ block: 'nearest' }); f.setAttribute('aria-activedescendant', act.id) }
    else f.removeAttribute('aria-activedescendant')
  }
  function filter() {
    var q = f.value.trim().toLowerCase(), p = q.replace(/^\\/+|\\/+$/g, '')
    all.forEach(function (b) { if (b !== add) b.hidden = !!q && b.getAttribute('data-k').indexOf(q) < 0 && !(b.id === 'mvnone' && 'no collection'.indexOf(q) >= 0) })
    var fresh = !!p && rule.test(p) && paths.indexOf(p) < 0
    add.hidden = !fresh; add.value = p; add.querySelector('.p').textContent = p
    hint.textContent = p && !fresh && paths.indexOf(p) < 0 ? 'A path is 1 to 4 parts of a-z, 0-9, dot, dash or underscore, split by /.' : ''
    var s = shown(); mark(fresh && s.length === 1 ? add : s[0])
  }
  root.querySelector('.mvb').addEventListener('click', function () { f.value = ''; filter(); d.showModal(); f.focus() })
  d.querySelector('.x').addEventListener('click', function () { d.close() })
  d.addEventListener('click', function (e) { if (e.target === d) d.close() })
  f.addEventListener('input', filter)
  f.addEventListener('keydown', function (e) {
    var s = shown(), i = s.indexOf(act)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (s.length) mark(s[(i + (e.key === 'ArrowDown' ? 1 : s.length - 1)) % s.length])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (act) act.click()
    }
  })
  all.forEach(function (b) { b.addEventListener('mousemove', function () { if (!b.disabled && act !== b) mark(b) }) })
})()
</script>`
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
      case 'title':
        await store.setAttrs(slug, { title: field('title') || null }, email)
        return back()
      case 'move': {
        const to = (field('new') || field('collection')).toLowerCase().replace(/^\/+|\/+$/g, '') || null
        await store.setAttrs(slug, { collection: to }, email)
        return back(`/_s/${encodeURIComponent(slug)}?moved`)
      }
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
<td class="o">${person(c.owner)}</td><td class="n">${c.shares}</td><td class="t">${when(c.updatedAt)}</td></tr>`)
  return page('Collections', `${STYLE}<div class="app">${nav(email, env, 'collections')}<div class="hd"><h1>Collections</h1></div>
<p class="sub">Every collection. Anyone at Metabase can see the shares in a collection.</p>
${rows.length ? `<div class="scroll"><table class="lst"><thead><tr><th>Collection</th><th>Owner</th><th class="r">Shares</th><th>Updated</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<p class="sub">No collections yet.</p>'}</div>`, { poll: false })
}
