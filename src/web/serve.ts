import { zipSync } from 'fflate'
import type { Env } from '../env'
import { ago, esc, notFound, page } from '../render/page'
import { render } from '../render/files'
import { canRead, isQueryStore, type ShareStore, type ShareSummary } from '../store'
import type { Collection, ShareInfo } from '../api-types'
import { contentBase, hostKind } from '../origins'
import { approvePage, tokenPage } from './tokens'
import { sharePage } from './manage'
import { ICON, STYLE, copyLink, iconLink, nav, person, privateTag, recency, when } from './shell'
import { uploadToken, uploadUi } from './upload'

const summary = (s: ShareInfo): [string, ShareSummary] =>
  [s.slug, { n: s.fileCount, t: s.updatedAt, o: s.owner, vis: s.visibility,
    ...(s.title ? { title: s.title } : {}), ...(s.collection ? { c: s.collection } : {}) }]

// ?q= on collection rows: every word of q is the start of a word of the
// slug or the title, as the share search takes each word as a prefix
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const colMatch = (q: string) => {
  const qs = words(q)
  return (k: Collection) => {
    const ws = words(`${k.slug} ${k.title ?? ''}`)
    return qs.every((w) => ws.some((x) => x.startsWith(w)))
  }
}

export async function serve(url: URL, email: string | null, env: Env, store: ShareStore, accept: string | null): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice(1))
  // share links on the listing go to the content host; '' on a single host
  const content = contentBase(url, env)

  // PUBLIC: share content only. No listing (it would expose every slug and
  // burn the 1k/day KV list quota), no token page, no stats.
  if (env.PUBLIC && (key === '' || key === '_token' || key === '_stats' || key === '_device'
    || key === '_collections' || key.startsWith('_s/'))) return notFound()

  if (key === '') {
    // /?mine: admin's bookmarkable "just my shares" view (non-admins
    // already see only their own)
    const isAdmin = email === env.ADMIN_EMAIL
    const admin = isAdmin && !url.searchParams.has('mine')
    // ?q=: full text search (D1+R2), best match first; ?c=: the shares of
    // a collection that the viewer can read (as the JSON API);
    // ?view=collections: collection rows only
    const q = url.searchParams.get('q')?.trim() || ''
    const c = url.searchParams.get('c') || ''
    const query = isQueryStore(store) ? store : null
    const onlyCols = !!query && !c && url.searchParams.get('view') === 'collections'
    let sorted: [string, ShareSummary][] = []
    let col: Collection | null = null
    if (query && c) {
      // a private collection of others answers as a missing one
      col = await query.collection(c, email)
      if (!col) return notFound()
      sorted = (await query.queryShares({ collection: c, viewer: email, limit: 1000 })).map(summary)
    } else if (onlyCols) {
      // no share rows
    } else if (query && q) {
      sorted = (await query.search(q, admin ? undefined : email!, email, 200)).map(summary)
    } else {
      // you see your shares; admin sees everyone's (with an owner column)
      // but the private shares of others
      const mine = [...await store.shares()]
        .filter(([, s]) => (s.o || env.ADMIN_EMAIL) === email || (admin && s.vis !== 'private'))
      // newest first; pre-timestamp shares (no metadata) sink to the bottom
      sorted = mine.sort((a, b) => b[1].t - a[1].t || a[0].localeCompare(b[0]))
    }
    // collection rows: yours (owned, or holding a share of yours); admin in
    // Everyone: every collection the admin can read
    let cols: Collection[] = []
    if (query && !c) {
      cols = admin ? await query.collections('', email) : await query.collectionsFor(email!)
      if (q) cols = cols.filter(colMatch(q))
    }
    const owners = admin || !!c
    // view logs, one get per row (reads are 100k/day; lists are the scarce thing)
    const views = new Map(await Promise.all(sorted.map(async ([p]) =>
      [p, await store.views(p)] as const)))
    const viewCell = (p: string) => {
      const v = views.get(p)
      if (!v) return '<td class="v"></td>'
      const who = Object.entries(v).sort((a, b) => b[1].last - a[1].last)
        .map(([e, x]) => `${e.split('@')[0]} ×${x.n} ${ago(x.last)}`).join('\n')
      const n = Object.keys(v).length
      return `<td class="v" title="${esc(who)}">${n} viewer${n === 1 ? '' : 's'}</td>`
    }
    const timeCell = (t: number) => `<td class="t ${t ? recency(t) : 'old'}" title="${
      t ? new Date(t).toISOString() : 'published before timestamps existed'}">${ago(t)}</td>`
    // the name cell; a share in a collection (outside the collection view)
    // shows "collection / slug", the collection part links to its view
    const nameCell = (p: string, s: ShareSummary) => {
      const href = `${content}/${esc(p)}/`
      const name = s.c && !c
        ? `<div class="nm">${s.title ? `<a class="ti" href="${href}">${esc(s.title)}</a>` : ''}<span class="slug"><a class="cl" href="/?c=${
          encodeURIComponent(s.c)}">${esc(s.c)}</a> / <a href="${href}">${esc(p)}</a></span></div>`
        : `<a class="nm" href="${href}">${s.title ? `<span class="ti">${esc(s.title)}</span>` : ''}<span class="slug">${esc(p)}</span></a>`
      return `<td class="s">${name}${
        s.vis === 'public' ? '<span class="pub" title="opens without login">public</span>' : s.vis === 'private' ? privateTag : ''}</td>`
    }
    const shareRow = ([p, s]: [string, ShareSummary]) =>
      `<tr data-p="/${esc(p)}/">${nameCell(p, s)}${
        owners ? `<td class="o">${person(s.o || env.ADMIN_EMAIL)}</td>` : ''
      }<td class="n">${s.n} file${s.n === 1 ? '' : 's'}</td>${viewCell(p)}${timeCell(s.t)}<td class="acts">${copyLink(`${content}/${p}/`)}${
        query ? ` ${iconLink(`/_s/${encodeURIComponent(p)}`, 'gear', 'Settings')}` : ''}</td></tr>`
    // a collection row has no peek (no data-p)
    const colRow = (k: Collection) =>
      `<tr class="col"><td class="s"><a class="nm fd" href="/?c=${encodeURIComponent(k.slug)}">${ICON.folder}<span class="nmc">${
        k.title ? `<span class="ti">${esc(k.title)}</span>` : ''}<span class="slug">${esc(k.slug)}</span></span></a></td>${
        owners ? `<td class="o">${person(k.owner)}</td>` : ''
      }<td class="n">${k.shares} share${k.shares === 1 ? '' : 's'}</td><td class="v"></td>${timeCell(k.updatedAt)}<td class="acts"></td></tr>`
    // one list by updatedAt; a search keeps the share order (best match)
    // after the matching collections
    const items: { t: number; html: string }[] = [
      ...cols.map((k) => ({ t: k.updatedAt, html: colRow(k) })),
      ...sorted.map((r) => ({ t: q ? -1 : r[1].t, html: shareRow(r) })),
    ]
    const rows = (q ? items : items.sort((a, b) => b.t - a.t)).map((r) => r.html)
    const head = `<thead><tr><th>Share</th>${owners ? '<th>Owner</th>' : ''}<th class="r">Files</th><th class="r">Viewers</th><th>Updated</th><th></th></tr></thead>`
    // the scope toggle (admin) and the view filter keep each other and the search text
    const href = (o: { mine: boolean; cols: boolean }) => {
      const ps = [...(o.mine ? ['mine'] : []), ...(o.cols ? ['view=collections'] : []), ...(q ? [`q=${encodeURIComponent(q)}`] : [])]
      return `/${ps.length ? `?${ps.join('&')}` : ''}`
    }
    const seg = (label: string, on: boolean, h: string) =>
      `<a href="${h}"${on ? ' class="on" aria-current="true"' : ''}>${label}</a>`
    const scope = isAdmin && !c
      ? `<div class="scope" role="group" aria-label="Scope">${seg('Mine', !admin, href({ mine: true, cols: onlyCols }))}${
        seg('Everyone', admin, href({ mine: false, cols: onlyCols }))}</div>`
      : ''
    const filter = query && !c
      ? `<div class="scope" role="group" aria-label="Show">${seg('All', !onlyCols, href({ mine: isAdmin && !admin, cols: false }))}${
        seg('Collections', onlyCols, href({ mine: isAdmin && !admin, cols: true }))}</div>`
      : ''
    // new share by upload; in a collection view it lands in that collection
    const up = query?.commit ? `<span class="hdup">${uploadUi({ token: await uploadToken(env, email!), mode: 'new', collection: c || undefined })}</span>` : ''
    const title = col ? (col.title ? esc(col.title) : `Collection <code>${esc(c)}</code>`) : q ? 'Search' : admin ? 'Shares' : 'My shares'
    const colHead = col ? `<p class="sub chd"><span class="mono">${esc(col.slug)}</span>${person(col.owner)}<span>${
      col.shares} share${col.shares === 1 ? '' : 's'}</span>${Object.entries(col.meta).map(([k, v]) =>
      `<span class="tag">${esc(k)}: ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</span>`).join('')}</p>` : ''
    const empty = q || c ? 'No match.' : onlyCols ? 'No collections yet.' : 'No shares yet.'
    return page(c ? 'Collection' : q ? 'Search' : admin ? 'Shares' : 'My shares', `<style>
  .hd .hdup{margin-left:auto}
  .hd .scope+.hdup,.hd .scope+.scope{margin-left:0}
  .chd{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .9rem}
  .lst .fd{flex-direction:row;align-items:center;gap:.55rem}
  .lst .fd svg{flex:none;width:18px;height:18px;color:var(--muted)}
  .lst .nmc{display:flex;flex-direction:column;min-width:0}
  .lst .fd:hover .ti,.lst .fd:hover .slug:only-child{color:var(--link)}
  .lst div.nm a{color:inherit;text-decoration:none}
  .lst div.nm a:hover{color:var(--link)}
  .lst .slug a.cl{color:var(--link)}
  .lst .slug a.cl:hover{text-decoration:underline}
  #q{width:100%;box-sizing:border-box;font:inherit;font-size:.9rem;padding:.5rem .75rem;
    background:var(--code-bg);color:var(--fg);border:1px solid var(--border);
    border-radius:6px;margin:0 0 .75rem}
  #q:focus{outline:2px solid var(--link);outline-offset:-1px}
  #pv{display:none;position:fixed;z-index:10;max-width:44rem;max-height:45vh;overflow:hidden;
    background:var(--code-bg);border:1px solid var(--border);border-radius:6px;
    box-shadow:0 4px 16px rgba(0,0,0,.25);padding:.5rem .75rem}
  /* invisible bridges above/below: crossing the row->card gap stays "inside" */
  #pv::before{content:'';position:absolute;left:0;right:0;top:-14px;height:14px}
  #pv::after{content:'';position:absolute;left:0;right:0;bottom:-14px;height:14px}
  #pv .f{color:var(--muted);font-size:.75rem;margin:0 3.5rem .25rem 0;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #pv .c{position:absolute;top:.35rem;right:.4rem;display:flex;color:var(--muted);background:none;
    border:1px solid var(--border);border-radius:5px;padding:.2rem;cursor:pointer}
  #pv .c svg{width:14px;height:14px}
  #pv .c:focus-visible{outline:2px solid var(--link);outline-offset:2px}
  #pv .c:hover{color:var(--fg);border-color:var(--muted)}
  #pv pre{margin:0;padding:0;background:none;min-width:0;width:auto;left:0;transform:none;
    max-width:none;font-size:.75rem;line-height:1.4;white-space:pre-wrap;overflow:hidden}
</style>
${STYLE}<div class="app">${nav(email!, env, 'shares')}
<div class="hd"><h1>${title}</h1>${filter}${scope}${up}</div>${colHead}
<form method="get" action="/">${admin ? '' : isAdmin ? '<input type="hidden" name="mine" value="">' : ''}${
  onlyCols ? '<input type="hidden" name="view" value="collections">' : ''}
<input id="q" name="q" value="${esc(q)}" placeholder="Search shares" aria-label="Search shares" autofocus></form>
${rows.length ? `<div class="scroll"><table class="lst">${head}<tbody id="shares">${rows.join('')}</tbody></table></div>` : `<p class="sub">${empty}</p>`}
${q || c ? '<p><small><a href="/">All shares</a></small></p>' : ''}
</div>
<script>
document.getElementById('q').addEventListener('input', function () {
  var q = this.value.toLowerCase()
  document.querySelectorAll('#shares tr').forEach(function (tr) {
    tr.style.display = tr.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : ''
  })
})
var pv = document.createElement('div')
pv.id = 'pv'
pv.innerHTML = '<div class="f"></div><button type="button" class="c" aria-label="Copy" title="Copy">${ICON.copy}</button><pre></pre>'
document.body.appendChild(pv)
var pvCache = {}, pvHide = null, pvCur = null
function hidePv() { pv.style.display = 'none'; pvCur = null }
function peek(u) {
  return pvCache[u]
    ? Promise.resolve(pvCache[u])
    : fetch(u + '_peek').then(function (r) { return r.json() })
        .then(function (j) { pvCache[u] = j; return j })
}
pv.addEventListener('mouseenter', function () { clearTimeout(pvHide) })
pv.addEventListener('mouseleave', function () { pvHide = setTimeout(hidePv, 150) })
pv.querySelector('.c').addEventListener('click', function () {
  var b = this
  fetch(pv.dataset.u + '_peek?full', { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) { return navigator.clipboard.writeText(j.text) })
    .then(function () { appToast('Copied') }, function () { appToast('Could not copy') })
})
document.querySelectorAll('#shares tr').forEach(function (tr) {
  var u = tr.getAttribute('data-p')
  if (!u) return
  tr.addEventListener('mouseenter', function () {
    clearTimeout(pvHide)
    pvCur = u
    peek(u).then(function (j) {
      if (pvCur !== u) return
      pv.querySelector('.f').textContent = j.file
      pv.querySelector('pre').textContent = j.text
      pv.dataset.u = u
      var r = tr.getBoundingClientRect()
      pv.style.left = Math.min(r.left + 24, innerWidth - 400) + 'px'
      pv.style.display = 'block'
      var below = innerHeight - r.bottom - 8
      if (below < pv.offsetHeight && r.top > innerHeight / 2) {
        pv.style.top = Math.max(4, r.top - pv.offsetHeight - 4) + 'px'
      } else {
        pv.style.top = (r.bottom + 4) + 'px'
      }
    }).catch(function () {})
  })
  tr.addEventListener('mouseleave', function () {
    pvHide = setTimeout(hidePv, 150)
  })
})
// warm the peek cache so hovers are instant (4 in flight at a time)
var pvq = Array.prototype.map.call(
  document.querySelectorAll('#shares tr[data-p]'),
  function (tr) { return tr.getAttribute('data-p') })
var pvActive = 0
function pvPump() {
  while (pvq.length && pvActive < 4) {
    (function (u) {
      pvActive++
      peek(u).catch(function () {}).then(function () { pvActive--; pvPump() })
    })(pvq.shift())
  }
}
pvPump()
</script>`, { vsrc: JSON.stringify([sorted, cols]), poll: false })
  }

  // /_stats (admin): shares + files per owner from the cached _man/ list,
  // pushes from the _pushes counter (counted since it was added)
  if (key === '_stats') {
    if (email !== env.ADMIN_EMAIL) return new Response('forbidden', { status: 403 })
    const pushes = await store.pushes()
    const by = new Map<string, { shares: number; files: number; pushes: number }>()
    const row = (o: string) => by.get(o) || by.set(o, { shares: 0, files: 0, pushes: pushes[o] || 0 }).get(o)!
    for (const s of (await store.shares()).values()) {
      const b = row(s.o || env.ADMIN_EMAIL)
      b.shares++; b.files += s.n
    }
    Object.keys(pushes).forEach(row)
    const rows = [...by].sort((a, b) => b[1].shares - a[1].shares)
    const bar = (n: number, max: number) => '█'.repeat(n && Math.max(1, Math.round(n / max * 30)))
    const maxS = Math.max(1, ...rows.map(([, b]) => b.shares))
    const maxP = Math.max(1, ...rows.map(([, b]) => b.pushes))
    return page('Activity', `${STYLE}<div class="app">${nav(email, env, 'activity')}<h1>Activity</h1>
<div class="scroll"><table class="auto"><tr><th>Owner</th><th class="r">Shares</th><th></th><th class="r">Files</th><th class="r">Pushes</th><th></th></tr>${rows.map(([o, b]) =>
  `<tr><td>${person(o)}</td><td class="r">${b.shares}</td><td>${bar(b.shares, maxS)}</td>
<td class="r">${b.files}</td><td class="r">${b.pushes}</td><td>${bar(b.pushes, maxP)}</td></tr>`).join('')}</table></div>
<p><small>Pushes are counted since the counter was added.</small></p>${await auditTable(store)}</div>`,
    { poll: false })
  }

  // /_token: personal CLI token + setup, derived from the signed-in session
  if (key === '_token') return tokenPage(url, env, email!)
  if (key === '_device' || (key === 'cli' && hostKind(url, env) === 'app')) return approvePage(url, env, email!)

  // the collections page of old: the list's Collections filter
  if (key === '_collections') return Response.redirect(`${url.origin}/?view=collections`, 302)
  if (key.startsWith('_s/')) return sharePage(url, env, store, email!, key.slice('_s/'.length))

  // reserved namespace: /_own/... must not render or list (slug enumeration)
  if (key.startsWith('_')) return notFound()

  // One read gate for every path below: content, _peek, _zip, the
  // directory listing, the redirects and <slug>@<n>. A reader who may not
  // read the share gets the answer of a slug that does not exist.
  const access = await store.access(key.split('/')[0])
  if (access && !canRead(access, email)) return notFound()

  // /slug/_peek: first lines of the share's main file, for hover previews;
  // ?full: all of its text, for the preview's copy button
  if (key.endsWith('/_peek')) {
    const prefix = key.slice(0, -'_peek'.length)
    const names = await store.filesUnder(prefix)
    if (!names.length) return notFound()
    const pick = names.find((n) => n.endsWith('/index.md')) || names[0]
    const buf = await store.getBytes(pick)
    let text
    if (buf && !new Uint8Array(buf, 0, Math.min(4096, buf.byteLength)).includes(0)) {
      text = url.searchParams.has('full')
        ? new TextDecoder().decode(buf)
        : new TextDecoder().decode(buf.slice(0, 8192)).split('\n').slice(0, 10)
          .map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l)).join('\n')
    } else {
      text = names.map((n) => n.slice(prefix.length)).slice(0, 10).join('\n')
    }
    return new Response(JSON.stringify({ file: pick.slice(prefix.length), text }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-cache' },
    })
  }

  // /slug/_zip: whole share as a zip (in-memory; KV caps files at 25MB)
  if (key.endsWith('/_zip')) {
    const prefix = key.slice(0, -'_zip'.length)
    const names = await store.filesUnder(prefix)
    if (!names.length) return notFound()
    const files: Record<string, Uint8Array> = {}
    for (const n of names) {
      files[n.slice(prefix.length)] = new Uint8Array((await store.getBytes(n))!)
    }
    const base = prefix.replace(/\/$/, '').split('/').pop()
    return new Response(zipSync(files), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${base}.zip"`,
        'cache-control': 'private, no-cache',
      },
    })
  }

  if (key.endsWith('/')) {
    for (const cand of [`${key}index.md`, `${key}index.html`]) {
      const hit = await render(cand, env, store, accept)
      if (hit) return hit
    }
    const names = await store.filesUnder(key)
    if (!names.length) return notFound()
    // one file -> skip the listing, land on the file itself
    if (names.length === 1) return Response.redirect(`${url.origin}/${encodeURI(names[0])}`, 302)
    const items = names.map(
      (n) => `<li><a href="/${esc(n)}">${esc(n.slice(key.length))}</a></li>`,
    )
    return page(key, `<h1>${esc(key.replace(/\/$/, ''))}</h1><ul>${items.join('')}</ul>
<p><a href="/${esc(key)}_zip">download all (.zip)</a></p>`, { slug: !env.PUBLIC && key.split('/')[0] })
  }

  const hit = await render(key, env, store, accept)
  if (hit) return hit

  // /name -> /name/ when the share exists. Manifest get only, no lazy heal:
  // this path sees every 404 typo, and heals cost a list() each.
  if (await store.manifest(key, { heal: false })) {
    return Response.redirect(`${url.origin}/${key}/`, 302)
  }
  // subdirectory inside a share (/slug/receipts): redirect to /slug/receipts/
  // when the slug's manifest has files under that prefix
  const top = key.split('/')[0]
  if (top !== key) {
    const man = await store.manifest(top, { heal: false })
    if (man?.files.some((f) => f.startsWith(`${key.slice(top.length + 1)}/`))) {
      return Response.redirect(`${url.origin}/${encodeURI(key)}/`, 302)
    }
  }
  return notFound()
}

// newest audit rows (admin stats page); empty on stores without a log
async function auditTable(store: ShareStore) {
  if (!store.audit) return ''
  const rows = (await store.audit(100)).map((a) => `<tr><td class="t">${when(a.at)}</td>
<td class="o">${person(a.actor, true)}</td><td><span class="tag">${esc(a.action)}</span></td><td class="s mono">${a.share
    ? `<a href="/_s/${encodeURIComponent(a.share)}">${esc(a.share)}</a>` : ''}</td></tr>`)
  return `<h2>Audit log</h2>${rows.length
    ? `<div class="scroll"><table class="lst"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Share</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<p class="sub">No rows yet.</p>'}`
}
