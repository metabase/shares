// Uploads from the web app (file picker, drag and drop): the CLI publish
// protocol behind the session cookie. The page script sends
//   POST /_up/blobs/missing        newline-separated sha256 list
//   PUT  /_up/blobs/<sha256>       file bytes
//   POST /_up/publish/<slug>[?new=1]  PublishRequest JSON
// and this module forwards each one to the CLI handler (api/cli.ts) after
// its checks, so the owner check and the commit stay in one place.
//
// Share HTML must not reach these writes. The content host refuses every
// non-GET request. On the combined host share HTML has the app origin, so
// each request also needs X-Upload-Token, which only the app pages carry
// (they answer navigations only, refuse framing and set COOP).

import type { Env } from '../env'
import { signEmail, verifyEmail } from '../auth'
import { cli } from '../api/cli'
import type { ShareStore } from '../store'

export const UPLOAD_PREFIX = '/_up/'
export const UPLOAD_HEADER = 'x-upload-token'
const TAG = 'u.'
const TOKEN_SECONDS = 12 * 3600

// Platform limit of a Worker request body is 100 MB; a browser also reads
// each file into memory to hash it.
export const LIMITS = { fileBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, files: 1000 }

export const uploadToken = (env: Env, email: string) => signEmail(env, email, TOKEN_SECONDS, TAG)

const text = (status: number, msg: string) => new Response(`${msg}\n`, { status })
const mb = (n: number) => `${Math.round(n / 1048576)} MB`

export const isUpload = (req: Request, url: URL, env: Env) => !env.PUBLIC && url.pathname.startsWith(UPLOAD_PREFIX)
  && (req.method === 'POST' || req.method === 'PUT')

export async function upload(req: Request, url: URL, env: Env, store: ShareStore, email: string | null) {
  if (req.headers.get('origin') !== url.origin) return text(403, 'forbidden')
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return text(403, 'forbidden')
  if (!email) return text(401, 'not signed in; reload the page')
  const token = req.headers.get(UPLOAD_HEADER) || ''
  if (await verifyEmail(env, token, TAG) !== email) return text(403, 'upload token invalid or expired; reload the page')

  const rest = url.pathname.slice(UPLOAD_PREFIX.length)
  const forward = (path: string, body: BodyInit) => {
    const to = new URL(path, url)
    return cli(new Request(to, { method: req.method, body }), to, env, store, email)
  }

  if (rest === 'blobs/missing' && req.method === 'POST') {
    const body = await req.text()
    if (body.split('\n').filter((s) => s.trim()).length > LIMITS.files) {
      return text(413, `too many files: at most ${LIMITS.files}`)
    }
    return forward('/_blobs/missing', body)
  }

  if (rest.startsWith('blobs/') && req.method === 'PUT') {
    const tooBig = () => text(413, `file too large: at most ${mb(LIMITS.fileBytes)}`)
    if (Number(req.headers.get('content-length')) > LIMITS.fileBytes) return tooBig()
    const body = await req.arrayBuffer()
    if (body.byteLength > LIMITS.fileBytes) return tooBig()
    return forward(`/_${rest}`, body)
  }

  if (rest.startsWith('publish/') && req.method === 'POST') {
    let body: { files?: { sha256?: unknown }[] }
    try { body = await req.json() } catch { return text(400, 'bad json') }
    const files = Array.isArray(body.files) ? body.files : []
    if (files.length > LIMITS.files) return text(413, `too many files: at most ${LIMITS.files}`)
    const total = await totalBytes(env, files.map((f) => f?.sha256))
    if (total > LIMITS.totalBytes) return text(413, `upload too large: at most ${mb(LIMITS.totalBytes)} in all`)
    if (url.searchParams.get('new') === '1') {
      const slug = decodeURIComponent(rest.slice('publish/'.length)).replace(/\/$/, '')
      if (await store.owner(slug)) return text(409, `the slug ${slug} is taken; pick another`)
    }
    return forward(`/_${rest}`, JSON.stringify(body))
  }

  return text(404, 'not found')
}

// bytes of the distinct blobs a manifest names, from R2; blobs that are
// missing or malformed count 0 (the commit refuses them)
async function totalBytes(env: Env, shas: unknown[]) {
  if (!env.BLOBS) return 0
  const uniq = [...new Set(shas.filter((s): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)))]
  const heads = await Promise.all(uniq.map((s) => env.BLOBS.head(`blobs/${s}`)))
  return heads.reduce((n, h) => n + (h?.size ?? 0), 0)
}

// The upload control of an app page: buttons for the file and folder
// pickers, a page-wide drop zone and the dialog with per-file progress.
// mode new: a new share (in collection, when given); version: a new
// version of slug, which replaces its files.
export interface UploadOpts {
  token: string
  mode: 'new' | 'version'
  slug?: string
  collection?: string
}

export function uploadUi(o: UploadOpts) {
  const data = `data-up-token="${attr(o.token)}" data-up-mode="${o.mode}" data-up-slug="${attr(o.slug ?? '')}" data-up-coll="${attr(o.collection ?? '')}"`
  const head = o.mode === 'new'
    ? `<h2>New share${o.collection ? ` in <code>${esc(o.collection)}</code>` : ''}</h2>
<div class="two"><label>Slug<input name="slug" required autocomplete="off" spellcheck="false"></label>
<label>Title <span class="opt">optional</span><input name="title" autocomplete="off"></label></div>
<label class="upchk"><input type="checkbox" name="private">Private: only you can open it</label>`
    : `<h2>New version of <code>${esc(o.slug ?? '')}</code></h2>
<p class="hint">The files replace the live version. The old version stays in the history.</p>
<label>Message <span class="opt">optional</span><input name="message" autocomplete="off"></label>`
  return `${UP_STYLE}<span class="up" ${data}>
<button type="button" class="upbtn${o.mode === 'new' ? ' pri' : ''}" id="upbtn" aria-haspopup="menu" aria-expanded="false" aria-controls="upmenu">${o.mode === 'new' ? 'Upload' : 'Upload version'}${CHEVRON}</button>
<div class="upmenu" id="upmenu" role="menu" aria-labelledby="upbtn" hidden>
<button type="button" role="menuitem" tabindex="-1" data-up-pick="f">Files…</button>
<button type="button" role="menuitem" tabindex="-1" data-up-pick="d">Folder…</button>
</div>
<input type="file" multiple hidden data-up-in="f"><input type="file" webkitdirectory hidden data-up-in="d">
</span>
<div class="updrop" hidden><div><strong>Drop to upload</strong><span>${o.mode === 'new' ? 'Files or a folder become a new share' : `Files or a folder become a new version of ${esc(o.slug ?? '')}`}</span></div></div>
<dialog class="updlg" aria-label="Upload"><form method="dialog" novalidate>
${head}
<p class="upsum"></p>
<ul class="upl"></ul>
<p class="uperr" role="alert" hidden></p>
<div class="upbtns"><button type="button" data-up-x>Cancel</button><button type="submit" class="pri" data-up-go>Upload</button></div>
</form></dialog>
<script>${UP_SCRIPT.replace('__LIMITS__', JSON.stringify(LIMITS))}</script>`
}

const CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"/></svg>'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const attr = esc

const UP_STYLE = `<style>
  .up{position:relative;display:inline-flex;align-items:center}
  .app .upbtn{gap:.35rem}
  .app .upbtn svg{display:block;transition:transform .1s}
  .app .upbtn[aria-expanded=true] svg{transform:rotate(180deg)}
  .upmenu{position:absolute;right:0;top:calc(100% + .3rem);z-index:25;min-width:9.5rem;padding:.25rem;
    display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:8px;
    box-shadow:0 8px 24px rgba(0,0,0,.25)}
  .upmenu[hidden]{display:none}
  .app .upmenu [role=menuitem]{display:flex;width:100%;justify-content:flex-start;background:none;border:0;
    border-radius:6px;padding:.4rem .6rem;font-weight:400;font-size:.85rem;color:var(--fg);white-space:nowrap}
  .app .upmenu [role=menuitem]:hover,.app .upmenu [role=menuitem]:focus-visible{background:var(--hover)}
  .app .upmenu [role=menuitem]:focus{outline:none}
  .app .upmenu [role=menuitem]:focus-visible{outline:2px solid var(--link);outline-offset:-2px}
  @media (prefers-reduced-motion:reduce){.app .upbtn svg{transition:none}}
  .updrop{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:1rem;
    background:color-mix(in srgb,var(--bg) 70%,transparent);pointer-events:none}
  .updrop[hidden]{display:none}
  .updrop>div{display:flex;flex-direction:column;align-items:center;gap:.4rem;width:min(36rem,100%);
    box-sizing:border-box;padding:3rem 1.5rem;border:2px dashed var(--link);border-radius:14px;text-align:center;
    background:color-mix(in srgb,var(--link) 8%,var(--bg));color:var(--fg);box-shadow:0 8px 32px rgba(0,0,0,.25)}
  .updrop strong{font-size:1.1rem}
  .updrop span{color:var(--muted);font-size:.85rem}
  .updlg{width:min(34rem,calc(100vw - 2rem));max-height:calc(100vh - 4rem);box-sizing:border-box;padding:1rem 1.1rem;
    border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg);box-shadow:0 8px 32px rgba(0,0,0,.35)}
  .updlg[open]{display:flex;flex-direction:column}
  .updlg::backdrop{background:rgba(0,0,0,.45)}
  .updlg form{display:flex;flex-direction:column;gap:.6rem;margin:0;min-height:0;flex:1}
  .updlg h2{margin:0;font-size:1rem}
  .updlg .two{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
  @media (max-width:30rem){.updlg .two{grid-template-columns:1fr}}
  .updlg label{display:block;font-size:.78rem;color:var(--muted)}
  .updlg label input{display:block;width:100%;margin-top:.2rem}
  .updlg label.upchk{display:flex;align-items:center;gap:.45rem;font-size:.85rem;color:var(--fg)}
  .updlg label.upchk input{display:inline;width:auto;margin:0}
  .updlg .opt{font-size:.7rem;opacity:.8}
  .updlg .hint,.updlg .upsum{margin:0;font-size:.8rem;color:var(--muted)}
  .updlg .upl{list-style:none;margin:0;padding:0;overflow-y:auto;min-height:0;max-height:16rem;
    border:1px solid var(--border);border-radius:8px}
  .updlg .upl li{display:grid;grid-template-columns:1fr auto;gap:.15rem .6rem;padding:.35rem .6rem;font-size:.8rem;
    border-bottom:1px solid var(--border)}
  .updlg .upl li:last-child{border-bottom:0}
  .updlg .upl .p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;min-width:0}
  .updlg .upl .s{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .updlg .upl .bar{grid-column:1/-1;height:3px;border-radius:2px;background:var(--border);overflow:hidden}
  .updlg .upl .bar i{display:block;height:100%;width:0;background:var(--link);transition:width .15s}
  .updlg .upl li.done .bar i{background:var(--acc2)}
  .updlg .upl li.bad .s{color:var(--danger)}
  .updlg .upl li.bad .bar i{background:var(--danger);width:100%}
  .updlg .uperr{margin:0;font-size:.85rem;color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 45%,transparent);
    border-radius:8px;padding:.5rem .7rem;overflow-wrap:anywhere}
  .updlg .upbtns{display:flex;justify-content:flex-end;gap:.5rem}
  .updlg button:disabled,.updlg input:disabled{opacity:.55;cursor:default}
  @media (prefers-reduced-motion:reduce){.updlg .upl .bar i{transition:none}}
</style>`

// Paths follow the CLI (cli/files.ts collect): one .md/.html file becomes
// the index, another single file keeps its name, one folder publishes its
// tree, several items go at the top level, folders under their own name.
// .git folders and .DS_Store files are skipped.
const UP_SCRIPT = `
(function () {
  var root = document.querySelector('.up'); if (!root) return
  var L = __LIMITS__, d = root.dataset, mode = d.upMode
  var dlg = document.querySelector('.updlg'), form = dlg.querySelector('form')
  var list = dlg.querySelector('.upl'), sum = dlg.querySelector('.upsum'), err = dlg.querySelector('.uperr')
  var go = dlg.querySelector('[data-up-go]'), cancel = dlg.querySelector('[data-up-x]')
  var drop = document.querySelector('.updrop'), items = [], busy = false, blocked = ''
  var fmt = function (n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  var skip = function (name) { return name === '.git' || name === '.DS_Store' }
  var suffix = function () { var a = new Uint8Array(3); crypto.getRandomValues(a); return Array.from(a, function (b) { return b.toString(16).padStart(2, '0') }).join('') }
  var slugOf = function (name, isFile) {
    var n = isFile && name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name
    return n.trim().replace(/\\s+/g, '-').replace(/[\\/@]/g, '-').replace(/^_+/, '') || 'upload'
  }
  var single = function (f) { return /\\.md$/.test(f.name) ? 'index.md' : /\\.html$/.test(f.name) ? 'index.html' : f.name }

  // the Upload menu: Files... and Folder... (menu button pattern)
  var btn = root.querySelector('.upbtn'), menu = root.querySelector('.upmenu')
  var mitems = Array.from(menu.querySelectorAll('[role=menuitem]'))
  function openMenu(at) { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); mitems[(at + mitems.length) % mitems.length].focus() }
  function closeMenu(refocus) { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus() }
  btn.addEventListener('click', function () { if (menu.hidden) openMenu(0); else closeMenu(true) })
  btn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(e.key === 'ArrowDown' ? 0 : -1) }
  })
  menu.addEventListener('keydown', function (e) {
    var i = mitems.indexOf(document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mitems[(i + (e.key === 'ArrowDown' ? 1 : -1) + mitems.length) % mitems.length].focus() }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); mitems[e.key === 'Home' ? 0 : mitems.length - 1].focus() }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true) }
    else if (e.key === 'Tab') closeMenu(false)
  })
  document.addEventListener('click', function (e) { if (!root.contains(e.target)) closeMenu(false) })
  mitems.forEach(function (b) {
    b.addEventListener('click', function () {
      closeMenu(true)
      var i = root.querySelector('[data-up-in="' + b.dataset.upPick + '"]'); i.value = ''; i.click()
    })
  })
  root.querySelector('[data-up-in="f"]').addEventListener('change', function () {
    var fs = Array.from(this.files)
    if (!fs.length) return
    if (fs.length === 1) open([{ file: fs[0], path: single(fs[0]) }], slugOf(fs[0].name, true))
    else open(fs.map(function (f) { return { file: f, path: f.name } }), slugOf(fs[0].name, true))
  })
  root.querySelector('[data-up-in="d"]').addEventListener('change', function () {
    var fs = Array.from(this.files)
    if (!fs.length) return
    var top = fs[0].webkitRelativePath.split('/')[0]
    open(fs.filter(function (f) { return !f.webkitRelativePath.split('/').some(skip) })
      .map(function (f) { return { file: f, path: f.webkitRelativePath.split('/').slice(1).join('/') } }), slugOf(top, false))
  })

  // drag and drop anywhere on the page
  var depth = 0
  var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0 }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e) || busy || dlg.open) return; depth++; drop.hidden = false })
  document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; drop.hidden = true } })
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = busy || dlg.open ? 'none' : 'copy' } })
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return
    e.preventDefault(); depth = 0; drop.hidden = true
    if (busy || dlg.open) return
    var entries = Array.from(e.dataTransfer.items).map(function (i) { return i.webkitGetAsEntry && i.webkitGetAsEntry() }).filter(Boolean)
    // no entry API (or synthetic items): plain files at the top level
    if (!entries.length) {
      var fs = Array.from(e.dataTransfer.files).filter(function (f) { return !skip(f.name) })
      if (!fs.length) return
      return open(fs.length === 1 ? [{ file: fs[0], path: single(fs[0]) }]
        : fs.map(function (f) { return { file: f, path: f.name } }), slugOf(fs[0].name, true))
    }
    Promise.all(entries.map(function (en) { return walk(en, en.isDirectory && entries.length > 1 ? en.name + '/' : '') }))
      .then(function (lists) {
        var out = [].concat.apply([], lists)
        if (entries.length === 1 && entries[0].isFile && out.length === 1) out[0].path = single(out[0].file)
        open(out, slugOf(entries[0].name, entries[0].isFile))
      }, function (x) { fail('Could not read the dropped files: ' + x) })
  })
  // the files under entry en, with paths prefix + their path below en
  function walk(en, prefix) {
    if (skip(en.name)) return Promise.resolve([])
    if (en.isFile) return new Promise(function (res, rej) { en.file(function (f) { res([{ file: f, path: prefix + f.name }]) }, rej) })
    var rd = en.createReader(), all = []
    return new Promise(function (res, rej) {
      // readEntries answers in batches; an empty batch is the end
      (function next() {
        rd.readEntries(function (batch) {
          if (batch.length) { all = all.concat(batch); return next() }
          Promise.all(all.map(function (c) { return walk(c, c.isDirectory ? prefix + c.name + '/' : prefix) }))
            .then(function (ls) { res([].concat.apply([], ls)) }, rej)
        }, rej)
      })()
    })
  }

  function open(fs, slug) {
    items = fs.map(function (x) { return { file: x.file, path: x.path, li: null } }).sort(function (a, b) { return a.path < b.path ? -1 : 1 })
    if (!items.length) return fail('No files to upload.', true)
    var total = items.reduce(function (n, x) { return n + x.file.size }, 0)
    sum.textContent = items.length + ' file' + (items.length === 1 ? '' : 's') + ', ' + fmt(total)
    list.innerHTML = ''
    items.forEach(function (x) {
      var li = document.createElement('li')
      li.innerHTML = '<span class="p"></span><span class="s"></span><span class="bar"><i></i></span>'
      li.querySelector('.p').textContent = x.path
      li.querySelector('.s').textContent = fmt(x.file.size)
      list.appendChild(li); x.li = li
    })
    err.hidden = true; go.disabled = false; cancel.disabled = false; go.textContent = 'Upload'
    lock(false)
    if (form.slug) { form.slug.value = slugOf(slug, false) + '-' + suffix(); form.title.value = '' }
    if (form.message) form.message.value = ''
    var big = items.filter(function (x) { return x.file.size > L.fileBytes })
    big.forEach(function (x) { state(x, 'too large', 'bad') })
    blocked = big.length ? big.length + ' file' + (big.length === 1 ? ' is' : 's are') + ' over the limit of ' + fmt(L.fileBytes) + ' per file.'
      : items.length > L.files ? 'Too many files: ' + items.length + ', at most ' + L.files + '.'
      : total > L.totalBytes ? 'Upload too large: ' + fmt(total) + ', at most ' + fmt(L.totalBytes) + ' in all.' : ''
    if (!dlg.open) dlg.showModal()
    if (blocked) fail(blocked)
    else if (form.slug) { form.slug.focus(); form.slug.select() }
  }
  function fail(msg, toast) {
    if (toast) return appToast(msg, 2500)
    err.textContent = msg; err.hidden = false; busy = false
    lock(false)
    go.disabled = !!blocked; cancel.disabled = false; go.textContent = blocked ? 'Upload' : 'Retry'
  }
  function lock(on) { form.querySelectorAll('input').forEach(function (i) { i.disabled = on }) }
  function state(x, s, cls, pct) {
    x.li.querySelector('.s').textContent = s
    x.li.className = cls || ''
    if (pct !== undefined) x.li.querySelector('.bar i').style.width = pct + '%'
  }

  cancel.addEventListener('click', function () { if (!busy) dlg.close() })
  dlg.addEventListener('cancel', function (e) { if (busy) e.preventDefault() })
  form.addEventListener('submit', function (e) {
    e.preventDefault()
    if (busy) return
    var slug = mode === 'new' ? form.slug.value.trim() : d.upSlug
    if (!slug || slug[0] === '_' || /[\\/]|@\\d+$/.test(slug)) return fail('Pick a slug without "/", a leading "_" or an "@<number>" end.')
    run(slug).catch(function (x) { fail(String(x && x.message || x)) })
  })

  function req(method, path, body, onProgress) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest()
      x.open(method, path)
      x.setRequestHeader('x-upload-token', d.upToken)
      if (onProgress) x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total) }
      x.onload = function () {
        if (x.status >= 200 && x.status < 300) return res(x.responseText)
        var t = (x.responseText || '').trim()
        rej(new Error(x.status === 401 ? 'You are signed out. Reload the page and sign in.'
          : x.status === 413 ? t : t ? t.charAt(0).toUpperCase() + t.slice(1) + ' (' + x.status + ')' : 'HTTP ' + x.status))
      }
      x.onerror = function () { rej(new Error('Network error. Check the connection and retry.')) }
      x.send(body)
    })
  }
  function hex(buf) { return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0') }).join('') }

  async function run(slug) {
    busy = true; go.disabled = true; cancel.disabled = true; err.hidden = true; go.textContent = 'Uploading'
    lock(true)
    for (var i = 0; i < items.length; i++) {
      var x = items[i]
      if (!x.sha) { state(x, 'hashing', '', 0); x.sha = hex(await crypto.subtle.digest('SHA-256', await x.file.arrayBuffer())) }
    }
    var shas = Array.from(new Set(items.map(function (x) { return x.sha })))
    var missing = new Set((await req('POST', '/_up/blobs/missing', shas.join('\\n') + '\\n')).split('\\n').filter(Boolean))
    var bySha = {}
    items.forEach(function (x) {
      if (missing.has(x.sha) && !bySha[x.sha]) { bySha[x.sha] = x; state(x, 'waiting', '', 0) }
      else if (!missing.has(x.sha)) state(x, 'stored', 'done', 100)
    })
    var todo = Object.keys(bySha).map(function (k) { return bySha[k] }), failed = null
    async function worker() {
      while (todo.length && !failed) {
        var x = todo.shift()
        try {
          await req('PUT', '/_up/blobs/' + x.sha, x.file, function (p) { state(x, Math.round(p * 100) + '%', '', p * 100) })
          items.forEach(function (y) { if (y.sha === x.sha) state(y, 'uploaded', 'done', 100) })
        } catch (e) { state(x, 'failed', 'bad'); failed = failed || e }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    if (failed) throw failed
    var body = { files: items.map(function (x) { return { path: x.path, sha256: x.sha } }) }
    if (mode === 'new') {
      if (form.title.value.trim()) body.title = form.title.value.trim()
      if (d.upColl) body.collection = d.upColl
      if (form.private.checked) body.visibility = 'private'
    } else if (form.message.value.trim()) body.message = form.message.value.trim()
    go.textContent = 'Publishing'
    var r = JSON.parse(await req('POST', '/_up/publish/' + encodeURIComponent(slug) + (mode === 'new' ? '?new=1' : ''), JSON.stringify(body)))
    location.href = '/_s/' + encodeURIComponent(r.slug) + '?published=' + r.version
  }
})()
`
