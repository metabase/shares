// HTML shell of every rendered page.

export interface PageOpts {
  vsrc?: string
  copy?: boolean
  poll?: boolean
  slug?: string | false
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

// content fingerprint for the auto-refresh poll; djb2 is plenty for
// "did it change" and keeps page() synchronous
function vhash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// opts.vsrc: what the auto-refresh fingerprint hashes; defaults to the body.
// Pages with time-relative text pass stable data instead to avoid a
// fingerprint that changes every render (= infinite reload loop).
// opts.copy: show the fixed top-right button that copies the raw file.
// opts.poll: false disables the auto-refresh poll -- the listing page must
// not re-render itself every 15s (each render costs a KV list; 1k/day cap).
export function page(title: string, body: string, opts: PageOpts = {}) {
  const v = vhash(opts.vsrc || body)
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="v" content="${v}">
<script>try{var _t=localStorage.getItem('theme');if(_t)document.documentElement.setAttribute('data-theme',_t)}catch(e){}</script>
<style>
  :root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--link:#0969da;--border:#d1d9e0;
    --code-bg:#f6f8fa;--acc1:#953800;--acc2:#1a7f37;--target:#fff8c5}
  @media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#0d1117;--fg:#e6edf3;
    --muted:#8b949e;--link:#4493f8;--border:#30363d;--code-bg:#161b22;
    --acc1:#ffa657;--acc2:#7ee787;--target:#3a3000}}
  :root[data-theme=dark]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--link:#4493f8;
    --border:#30363d;--code-bg:#161b22;--acc1:#ffa657;--acc2:#7ee787;--target:#3a3000}
  :root[data-theme=tokyo]{--bg:#1a1b26;--fg:#c0caf5;--muted:#565f89;--link:#7aa2f7;
    --border:#292e42;--code-bg:#16161e;--acc1:#ff9e64;--acc2:#9ece6a;--target:#33301f}
  :root[data-theme=nord]{--bg:#2e3440;--fg:#d8dee9;--muted:#8492ab;--link:#88c0d0;
    --border:#3b4252;--code-bg:#3b4252;--acc1:#d08770;--acc2:#a3be8c;--target:#4c566a}
  body{max-width:42rem;margin:2rem auto;padding:0 1rem;font:16px/1.6 -apple-system,system-ui,sans-serif;
    background:var(--bg);color:var(--fg)}
  /* pre/table break out of the 42rem prose column: as wide as content needs,
     capped at the viewport, centered; overflow-x scrolls only past that */
  pre,table{background:var(--code-bg);padding:1rem;border-radius:6px;overflow-x:auto;
      box-sizing:border-box;width:fit-content;min-width:100%;
      max-width:calc(100vw - 2rem);position:relative;left:50%;transform:translateX(-50%)}
  table{display:block;background:none;padding:0}
  button.copy{display:block;margin:0 0 .25rem auto;font:inherit;font-size:.75rem;
      color:var(--muted);background:none;border:1px solid var(--border);border-radius:6px;
      padding:.1em .6em;cursor:pointer}
  button.copy:hover{color:var(--fg);border-color:var(--muted)}
  .cprow{display:flex;justify-content:flex-end;gap:.4rem;margin:0 0 .25rem}
  .cprow button.copy{margin:0}
  .cprow a{font-size:.75rem;color:var(--muted);border:1px solid var(--border);border-radius:6px;
      padding:.1em .6em;text-decoration:none}
  .cprow a:hover{color:var(--fg);border-color:var(--muted)}
  /* vertical rhythm, GitHub-style: blocks space below only; headings sit
     tight to the section they introduce, far from the one before */
  :is(h1,h2,h3,h4,h5,h6){line-height:1.25;margin:1.6em 0 .5em}
  p,ul,ol,blockquote,dl{margin:0 0 1em}
  /* loose lists (blank lines between items) wrap items in <p>: drop the
     paragraph gap so items group as a list instead of a column of paragraphs */
  li>p{margin:0}
  li+li{margin-top:.25em}li>p+p{margin-top:.5em}
  li>:is(ul,ol){margin:.25em 0 0}
  table,.mermaid,.reladraw{margin:0 0 1em}
  /* ~75ch measure: prose wraps evenly, headings avoid one-word last lines */
  p,li{text-wrap:pretty}:is(h1,h2,h3,h4,h5,h6){text-wrap:balance}
  code{background:var(--code-bg);padding:.1em .3em;border-radius:4px;font-size:.9em}
  pre code{background:none;padding:0}
  img{max-width:100%}
  a{color:var(--link)}
  blockquote{border-left:4px solid var(--border);margin-left:0;padding-left:1rem;color:var(--muted)}
  small{color:var(--muted)}
  footer{margin-top:3rem;padding-top:.75rem;border-top:1px solid var(--border)}
  /* diagrams break out of the 42rem prose column like pre/table */
  .mermaid,.reladraw{width:min(56rem,100vw - 2rem);position:relative;left:50%;transform:translateX(-50%)}
  .mermaid{text-align:center;overflow-x:auto}
  .mermaid svg{max-width:100%}
  .reladraw{text-align:center;overflow-x:auto}
  .reladraw svg{max-width:100%;height:auto}
  table{border-collapse:collapse}td,th{border:1px solid var(--border);padding:.3em .7em}
  .anchor{opacity:0;margin-right:.35em;text-decoration:none}
  :hover>.anchor{opacity:1}
  /* heading anchors hang in the left gutter so heading text stays flush */
  :is(h1,h2,h3,h4,h5,h6)>.anchor{position:absolute;margin-left:-1.1em}
  /* li anchors too: inline before a loose item's <p> would break the marker onto its own line */
  li>.anchor{position:absolute;margin-left:-3em}
  .footnotes{margin-top:2rem;border-top:1px solid var(--border);font-size:.9em}
  .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
  :target{background:var(--target)}
  #cpall{position:fixed;top:.75rem;right:.75rem;z-index:9;font:inherit;font-size:.75rem;
    color:var(--muted);background:var(--code-bg);border:1px solid var(--border);
    border-radius:6px;padding:.15em .6em;cursor:pointer}
  #cpall:hover{color:var(--fg);border-color:var(--muted)}
  #thg{position:fixed;bottom:.75rem;right:.75rem;z-index:9;font:inherit;font-size:.75rem;
    color:var(--muted);background:var(--code-bg);border:1px solid var(--border);
    border-radius:6px;padding:.1em .3em}
</style>
<link rel="stylesheet" data-hl media="(prefers-color-scheme: light)" href="${HLJS}/styles/github.min.css">
<link rel="stylesheet" data-hl media="(prefers-color-scheme: dark)" href="${HLJS}/styles/github-dark.min.css">
${opts.copy ? '<button id="cpall" title="copy raw file contents">copy</button>' : ''}
${body}
${opts.slug ? `<footer><small>clone this share: <code>share download ${esc(opts.slug)}</code>
 (no cli yet? grab it at <a href="/_token">/_token</a>)</small></footer>` : ''}
<script src="${HLJS}/highlight.min.js"></script>
<script>
(function () {
  var used = new Set(Array.from(document.querySelectorAll('[id]'), function (e) { return e.id }))
  function claim(want) {
    var id = want, n = 2
    while (used.has(id)) id = want + '.' + n++
    used.add(id)
    return id
  }
  function link(el, id) {
    el.id = id
    var a = document.createElement('a')
    a.href = '#' + id; a.textContent = '#'; a.className = 'anchor'
    el.prepend(a)
  }
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (h) {
    link(h, h.id || claim(h.textContent.trim().toLowerCase().replace(/[^\\w]+/g, '-').replace(/^-|-$/g, '') || 'h'))
  })
  // ordered-list items: id encodes the numbering path, e.g. item-3-2 = 3.b
  // footnote items skipped: they carry their own ids + backrefs
  document.querySelectorAll('ol > li').forEach(function (li) {
    if (li.closest('.footnotes')) return
    var path = [], el = li
    while (el && el.tagName === 'LI' && el.parentElement.tagName === 'OL') {
      var ol = el.parentElement
      path.unshift((ol.start || 1) + Array.prototype.indexOf.call(ol.children, el))
      el = ol.parentElement.closest('li')
    }
    link(li, claim('item-' + path.join('-')))
  })
  document.querySelectorAll('pre').forEach(function (pre) {
    if (pre.closest('#pv')) return
    var b = document.createElement('button')
    b.textContent = 'copy'; b.className = 'copy'
    b.onclick = function () {
      navigator.clipboard.writeText(pre.textContent).then(function () {
        b.textContent = 'copied'
        setTimeout(function () { b.textContent = 'copy' }, 1200)
      })
    }
    // diagram fences also get an "open on" link to the language's own
    // editor, source carried in the URL fragment (never sent to a server)
    var lang = pre.querySelector('code.language-mermaid') ? 'mermaid'
      : pre.querySelector('code.language-reladraw') ? 'reladraw' : null
    if (!lang) return pre.insertAdjacentElement('beforebegin', b)
    var a = document.createElement('a')
    a.target = '_blank'; a.rel = 'noopener'
    a.textContent = lang === 'mermaid' ? 'open on mermaid.live' : 'open on reladraw'
    a.href = lang === 'mermaid'
      ? 'https://mermaid.live/edit#base64:' + b64u(JSON.stringify({ code: pre.textContent, mermaid: '{"theme":"default"}' }))
      : 'https://reladraw.github.io/reladraw/#' + b64u(pre.textContent)
    var row = document.createElement('div')
    row.className = 'cprow'
    row.append(a, b)
    pre.insertAdjacentElement('beforebegin', row)
  })
  function b64u(s) {
    var bin = ''
    new TextEncoder().encode(s).forEach(function (x) { bin += String.fromCharCode(x) })
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  }
  // explicit theme replaces the auto (media-query) hljs stylesheets
  var THL = { light: 'github', dark: 'github-dark', tokyo: 'tokyo-night-dark', nord: 'nord' }
  var tname = ''
  try { tname = localStorage.getItem('theme') || '' } catch (e) {}
  if (THL[tname]) {
    document.querySelectorAll('link[data-hl]').forEach(function (l) { l.remove() })
    var hlink = document.createElement('link')
    hlink.rel = 'stylesheet'
    hlink.href = '${HLJS}/styles/' + THL[tname] + '.min.css'
    document.head.appendChild(hlink)
  }
  // highlight: load grammars for declared fence languages (clojure always,
  // for auto-detecting unlabeled blocks - it is not in the common build)
  var ALIAS = ${JSON.stringify(CODE_LANGS)}
  var need = { clojure: true }
  document.querySelectorAll('code[class*="language-"]').forEach(function (c) {
    var m = c.className.match(/language-([\\w-]+)/)
    if (m) need[ALIAS[m[1]] || m[1]] = true
  })
  // ALIAS picks which grammar file loads, but hljs also has to accept the
  // fence's own name (\`\`\`gleam -> language-gleam): unknown class names
  // otherwise render plain, they do not auto-detect
  Object.keys(ALIAS).forEach(function (a) {
    if (!hljs.getLanguage(a)) hljs.registerAliases(a, { languageName: ALIAS[a] })
  })
  var pending = 0
  function done() { if (--pending === 0) hljs.highlightAll() }
  Object.keys(need).forEach(function (l) {
    if (hljs.getLanguage(l)) return
    pending++
    var s = document.createElement('script')
    s.src = '${HLJS}/languages/' + l + '.min.js'
    s.onload = s.onerror = done
    document.head.appendChild(s)
  })
  if (!pending) hljs.highlightAll()
  // mermaid fences -> inline diagrams. Lazy CDN load only when present;
  // load failure just leaves the highlighted code block. The copy button
  // added above keeps a closure on the original pre, so it copies source.
  var mms = document.querySelectorAll('code.language-mermaid')
  if (mms.length) {
    var ms = document.createElement('script')
    ms.src = '${MERMAID}'
    ms.onload = function () {
      var dark = tname ? tname !== 'light' : matchMedia('(prefers-color-scheme: dark)').matches
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' })
      var nodes = []
      mms.forEach(function (c) {
        var d = document.createElement('div')
        d.className = 'mermaid'
        d.textContent = c.textContent
        c.closest('pre').replaceWith(d)
        nodes.push(d)
      })
      mermaid.run({ nodes: nodes })
    }
    document.head.appendChild(ms)
  }
  // reladraw fences -> inline SVG, same lazy/fallback deal as mermaid. A
  // parse error leaves that block as code.
  var rds = document.querySelectorAll('code.language-reladraw')
  var RDV = ${JSON.stringify(RELADRAWS)}, rdMods = {}
  // page theme wins over a file's own diagram theme:; tokyo has no
  // reladraw twin so it falls back to dark
  var rdDark = tname ? tname !== 'light' : matchMedia('(prefers-color-scheme: dark)').matches
  // try each version in order (each loaded at most once, only if needed);
  // a block no version can render stays as code
  function rdRender(c, i) {
    if (i >= RDV.length) return
    ;(rdMods[i] = rdMods[i] || import(RDV[i])).then(function (rd) {
      var d = document.createElement('div')
      d.className = 'reladraw'
      d.innerHTML = rd.compile(c.textContent, { theme: rd.THEMES[tname] || rd.THEMES[rdDark ? 'dark' : 'light'] })
      c.closest('pre').replaceWith(d)
    }).catch(function () { rdRender(c, i + 1) })
  }
  rds.forEach(function (c) { rdRender(c, 0) })
  // theme picker: fixed bottom-right on every rendered page
  var tsel = document.createElement('select')
  tsel.id = 'thg'; tsel.title = 'theme'
  ;['auto', 'light', 'dark', 'tokyo', 'nord'].forEach(function (o) {
    var op = document.createElement('option')
    op.value = o === 'auto' ? '' : o
    op.textContent = o
    tsel.appendChild(op)
  })
  tsel.value = tname
  tsel.addEventListener('change', function () {
    try { localStorage.setItem('theme', tsel.value) } catch (e) {}
    location.reload()
  })
  document.body.appendChild(tsel)
  // top-right copy: fetch() gets raw bytes via Accept negotiation, so this
  // copies the true file content even on pretty-rendered pages
  var cp = document.getElementById('cpall')
  if (cp) cp.addEventListener('click', function () {
    fetch(location.href, { cache: 'no-store' })
      .then(function (r) { return r.text() })
      .then(function (t) { return navigator.clipboard.writeText(t) })
      .then(function () {
        cp.textContent = 'copied'; setTimeout(function () { cp.textContent = 'copy' }, 1200)
      })
      .catch(function () {})
  })
  // cmd+c with nothing selected: copy [title](url) as a markdown link.
  // Brackets in the title are backslash-escaped so the link text survives.
  document.addEventListener('keydown', function (e) {
    if (!e.metaKey || e.key !== 'c' || getSelection().toString()) return
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return
    e.preventDefault()
    var t = document.title.replace(/[\\[\\]]/g, '\\\\$&')
    navigator.clipboard.writeText('[' + t + '](' + location.href.split('#')[0] + ')')
  })
  // auto-refresh: reload when a push changes the content fingerprint
  ${opts.poll === false ? '' : `setInterval(function () {
    fetch(location.href, { cache: 'no-store' })
      .then(function (r) { return r.text() })
      .then(function (t) {
        var m = t.match(/name="v" content="([^"]+)"/)
        if (m && m[1] !== '${v}') location.reload()
      })
      .catch(function () {})
  }, 15000)`}
})()
</script>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-cache' } },
  )
}

export const notFound = () => page('not found', '<h1>404</h1>')

export function ago(t: number) {
  if (!t) return '—'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}hr ${m % 60}min ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ${h % 24}hr ago`
  return new Date(t).toISOString().slice(0, 10)
}

// Grammar hints for the <pre> page. Unknown text extensions still render,
// just without a language class (hljs auto-detects among its common set).
// Values are highlight.js language names (also the CDN module filename).
export const CODE_LANGS: Record<string, string> = {
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure', bb: 'clojure',
  py: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash', bash: 'bash', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  c: 'c', h: 'c', cpp: 'cpp', diff: 'diff', patch: 'diff',
  gleam: 'rust', // no official hljs gleam grammar; rust keywords are close
  lis: 'rust', // Lisette: rust-like syntax, no hljs grammar of its own
}

const HLJS = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1'
// jsdelivr, not cdnjs: mermaid 11 ships no single-file build on cdnjs
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js'
// newest first; a diagram that fails to load or parse on one falls back to
// the next. Exact pins only: a floating range would run any future npm
// release on every viewer's page unreviewed. Bump deliberately.
const RELADRAWS = ['0.19.1', '0.18.0', '0.16.0']
  .map((v) => `https://cdn.jsdelivr.net/npm/reladraw@${v}/+esm`)
