import { zipSync } from 'fflate'
import type { Env } from '../env'
import { ago, esc, notFound, page } from '../render/page'
import { render } from '../render/files'
import type { ShareStore } from '../store'
import { contentBase, hostKind } from '../origins'
import { approvePage, tokenPage } from './tokens'

export async function serve(url: URL, email: string | null, env: Env, store: ShareStore, accept: string | null): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice(1))
  // share links on the listing go to the content host; '' on a single host
  const content = contentBase(url, env)

  // PUBLIC: share content only. No listing (it would expose every slug and
  // burn the 1k/day KV list quota), no token page, no stats.
  if (env.PUBLIC && (key === '' || key === '_token' || key === '_stats' || key === '_device')) return notFound()

  if (key === '') {
    // /?mine: admin's bookmarkable "just my shares" view (non-admins
    // already see only their own)
    const admin = email === env.ADMIN_EMAIL && !url.searchParams.has('mine')
    // you see your shares; admin sees everyone's (with an owner column)
    const mine = [...await store.shares()]
      .filter(([, s]) => admin || (s.o || env.ADMIN_EMAIL) === email)
    // newest first; pre-timestamp shares (no metadata) sink to the bottom
    const sorted = mine.sort((a, b) => b[1].t - a[1].t || a[0].localeCompare(b[0]))
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
    const rows = sorted.map(([p, s]) =>
      `<tr data-p="/${esc(p)}/"><td class="s"><a href="${content}/${esc(p)}/">${esc(p)}</a>${
        s.pub ? ' <span class="pub" title="opens without login">public</span>' : ''}</td>${
        admin ? `<td class="o">${esc((s.o || env.ADMIN_EMAIL).split('@')[0])}</td>` : ''
      }<td class="n">${s.n} file${
        s.n === 1 ? '' : 's'}</td>${viewCell(p)}<td class="t" title="${
        s.t ? new Date(s.t).toISOString() : 'published before timestamps existed'}">${
        ago(s.t)}</td><td><button data-u="${content}/${esc(p)}/">url</button></td></tr>`)
    return page('shares', `<style>
  .hd h1{margin:0 0 .5rem;font-size:1.3rem}
  #q{width:100%;box-sizing:border-box;font:inherit;font-size:.9rem;padding:.35em .6em;
    background:var(--code-bg);color:var(--fg);border:1px solid var(--border);
    border-radius:6px;margin:0 0 .75rem}
  #q:focus{outline:2px solid var(--link);outline-offset:-1px}
  table.lst{display:table;width:100%;min-width:0;max-width:none;left:auto;transform:none;
    background:none;padding:0;font-size:.9rem}
  .lst td{border:0;border-bottom:1px solid var(--border);padding:.3em .4em;white-space:nowrap}
  .lst td.s{width:100%;white-space:normal}
  .lst td.s a{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;
    text-decoration:none}
  .lst td.s a:hover{text-decoration:underline}
  .lst .pub{font-size:.7rem;color:var(--acc2);border:1px solid var(--acc2);border-radius:5px;
    padding:0 .35em}
  .lst td.o{color:var(--muted)}
  .lst td.n{color:var(--acc1);text-align:right}
  .lst td.v{color:var(--muted);text-align:right;cursor:default}
  .lst td.t{color:var(--acc2)}
  .lst button{font:inherit;font-size:.7rem;color:var(--muted);background:none;
    border:1px solid var(--border);border-radius:5px;padding:.05em .45em;cursor:pointer}
  .lst button:hover{color:var(--fg);border-color:var(--muted)}
  #pv{display:none;position:fixed;z-index:10;max-width:44rem;max-height:45vh;overflow:hidden;
    background:var(--code-bg);border:1px solid var(--border);border-radius:6px;
    box-shadow:0 4px 16px rgba(0,0,0,.25);padding:.5rem .75rem}
  /* invisible bridges above/below: crossing the row->card gap stays "inside" */
  #pv::before{content:'';position:absolute;left:0;right:0;top:-14px;height:14px}
  #pv::after{content:'';position:absolute;left:0;right:0;bottom:-14px;height:14px}
  #pv .f{color:var(--muted);font-size:.75rem;margin:0 3.5rem .25rem 0;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #pv .c{position:absolute;top:.35rem;right:.4rem;font:inherit;font-size:.7rem;
    color:var(--muted);background:none;border:1px solid var(--border);border-radius:5px;
    padding:.05em .45em;cursor:pointer}
  #pv .c:hover{color:var(--fg);border-color:var(--muted)}
  #pv pre{margin:0;padding:0;background:none;min-width:0;width:auto;left:0;transform:none;
    max-width:none;font-size:.75rem;line-height:1.4;white-space:pre-wrap;overflow:hidden}
</style>
<div class="hd"><h1>shares</h1></div>
<input id="q" placeholder="filter" autofocus>
<table class="lst"><tbody id="shares">${rows.join('')}</tbody></table>
${rows.length ? '' : '<p>No shares yet.</p>'}
<p><small><a href="/_token">cli setup</a>${
  email === env.ADMIN_EMAIL
    ? admin ? ' · <a href="/?mine">mine only</a>' : ' · <a href="/">everyone</a>'
    : ''}</small></p>
<script>
document.getElementById('q').addEventListener('input', function () {
  var q = this.value.toLowerCase()
  document.querySelectorAll('#shares tr').forEach(function (tr) {
    tr.style.display = tr.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : ''
  })
})
document.querySelectorAll('.lst button').forEach(function (b) {
  b.addEventListener('click', function () {
    navigator.clipboard.writeText(new URL(b.getAttribute('data-u'), location.href).href).then(function () {
      b.textContent = 'ok'; setTimeout(function () { b.textContent = 'url' }, 900)
    })
  })
})
var pv = document.createElement('div')
pv.id = 'pv'
pv.innerHTML = '<div class="f"></div><button class="c">copy</button><pre></pre>'
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
    .then(function () {
      b.textContent = 'copied'; setTimeout(function () { b.textContent = 'copy' }, 1000)
    })
    .catch(function () {})
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
</script>`, { vsrc: JSON.stringify(sorted), poll: false })
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
    return page('stats', `<h1>stats</h1>
<table><tr><th>owner</th><th>shares</th><th></th><th>files</th><th>pushes</th><th></th></tr>${rows.map(([o, b]) =>
  `<tr><td>${esc(o.split('@')[0])}</td><td>${b.shares}</td><td>${bar(b.shares, maxS)}</td>
<td>${b.files}</td><td>${b.pushes}</td><td>${bar(b.pushes, maxP)}</td></tr>`).join('')}</table>
<p><small>pushes counted since the counter was added</small></p>`,
    { poll: false })
  }

  // /_token: personal CLI token + setup, derived from the signed-in session
  if (key === '_token') return tokenPage(url, env, email!)
  if (key === '_device' || (key === 'cli' && hostKind(url, env) === 'app')) return approvePage(url, env, email!)

  // reserved namespace: /_own/... must not render or list (slug enumeration)
  if (key.startsWith('_')) return notFound()

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
