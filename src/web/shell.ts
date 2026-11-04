// Shared look of the web app pages (shares, collections, share page,
// install, activity): one stylesheet, the nav, and the time cell. Share
// content pages do not use it and keep the 42rem prose column of page().

import type { Env } from '../env'
import { ago, esc } from '../render/page'

// Put STYLE before the page body. Wrap the page in <div class="app">.
// It also holds the toast and the click handler of the copy buttons
// (copyLink, codeBlock).
export const STYLE = `<style>
  body{max-width:68rem}
  pre,table{width:auto;min-width:0;max-width:none;left:auto;transform:none}
  .app h1{margin:0;font-size:1.3rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .app h2{font-size:1rem;margin:1.5rem 0 .4rem}
  .app .sub{color:var(--muted);margin:.25rem 0 1rem;font-size:.85rem}
  nav.top{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem;font-size:.85rem;color:var(--muted);
    margin:0 0 1.5rem;padding-bottom:.6rem;border-bottom:1px solid var(--border)}
  nav.top a{color:var(--muted);text-decoration:none;padding:.25rem .6rem;border-radius:6px}
  nav.top a:hover{color:var(--fg);background:var(--hover)}
  nav.top a.on{color:var(--fg);background:var(--hover);font-weight:500}
  nav.top .me{margin-left:auto;padding:0 .4rem;overflow-wrap:anywhere}
  nav.top select{font:inherit;font-size:.8rem;background:var(--code-bg);color:var(--fg);
    border:1px solid var(--border);border-radius:6px;padding:.15rem .3rem}
  .app table{display:table;width:100%;background:none;padding:0;font-size:.85rem;border-collapse:collapse}
  .app .scroll{overflow-x:auto}
  .app table.auto{width:auto;margin-top:1rem}
  .app th{text-align:left;color:var(--muted);font-weight:normal}
  .app td,.app th{border:0;border-bottom:1px solid var(--border);padding:.3em .4em;white-space:nowrap;
    vertical-align:top}
  .app td.w{width:100%;white-space:normal;overflow-wrap:anywhere}
  .app td.r,.app th.r{text-align:right;font-variant-numeric:tabular-nums}
  .app .hd{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:0 0 .75rem}
  .app .scope{display:flex;gap:.25rem;margin-left:auto;font-size:.8rem}
  .app .scope a{text-decoration:none;color:var(--muted);padding:.15rem .55rem;border:1px solid var(--border);border-radius:6px}
  .app .scope a:hover{color:var(--fg)}
  .app .scope a.on{color:var(--fg);background:var(--hover)}
  .lst thead th{font-size:.75rem;padding:.3em .5em}
  .lst td{padding:.55rem .5rem;vertical-align:middle;color:var(--muted)}
  .lst tbody tr:hover td{background:var(--hover)}
  .lst td.s{width:100%;min-width:13rem;white-space:normal;color:var(--fg)}
  .lst .nm{display:flex;flex-direction:column;text-decoration:none;min-width:0}
  .lst .ti{color:var(--fg);font-size:.95rem;font-weight:500;overflow-wrap:break-word}
  .lst .slug{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--muted);overflow-wrap:break-word}
  .lst .slug:only-child{color:var(--fg);font-size:.85rem}
  .lst .nm:hover .slug{color:var(--link)}
  .lst .pub{display:inline-block;font-size:.7rem;color:var(--muted);border:1px solid var(--border);border-radius:5px;
    padding:0 .35em;margin-top:.15rem}
  .lst td.n,.lst td.v{text-align:right;font-variant-numeric:tabular-nums}
  .lst td.v{cursor:default}
  .lst .acts{opacity:.55;transition:opacity .1s}
  .lst tr:hover .acts,.lst .acts:focus-within{opacity:1}
  @media (hover:none){.lst .acts{opacity:1}}
  .app .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
  .app dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem;font-size:.85rem;margin:0}
  .app dt{color:var(--muted)}
  .app dd{margin:0;overflow-wrap:anywhere}
  .sh .top{display:flex;flex-wrap:wrap;align-items:flex-start;gap:.5rem 1rem}
  .sh .top>div:first-child{min-width:0;flex:1 1 20rem}
  .sh .acts{display:flex;align-items:center;gap:.4rem;margin-left:auto;flex:none}
  .app .btn.pri{background:var(--link);border-color:var(--link);color:var(--bg)}
  .sh .slugline{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;color:var(--muted);
    margin:.2rem 0 1.25rem;overflow-wrap:anywhere}
  .sh .slugline a{color:inherit}
  .sh dl.strip{display:flex;flex-wrap:wrap;gap:.4rem 2rem;border:1px solid var(--border);border-radius:8px;
    padding:.6rem 1rem}
  .sh dl.strip dt{font-size:.75rem}
  .sh .meta{margin:.75rem 0 0;font-size:.85rem}
  .sh .meta span{color:var(--muted);font-size:.75rem}
  .sh .frm{display:grid;gap:1rem;max-width:36rem}
  .sh .frm form{display:grid;grid-template-columns:1fr auto;gap:.3rem .6rem;align-items:end;margin:0}
  .sh .frm .two{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
  .sh .frm label{display:block;font-size:.78rem;color:var(--muted)}
  .sh .frm label input{display:block;width:100%;margin-top:.2rem}
  .sh .frm .hint{grid-column:1/-1;font-size:.75rem;color:var(--muted);margin:0}
  .sh .frm form.dz{border:1px solid color-mix(in srgb,var(--danger) 45%,transparent);border-radius:8px;padding:.75rem 1rem}
  .sh .dzh{color:var(--danger);font-size:.85rem;margin:.5rem 0 0}
  @media (max-width:30rem){.sh .frm .two{grid-template-columns:1fr}}
  .sh .moved{border:1px solid var(--border);border-radius:8px;padding:.4rem .8rem;font-size:.85rem;margin:0 0 1rem}
  .sh .mvrow{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem}
  .sh .mvrow .lbl{font-size:.78rem;color:var(--muted);flex-basis:100%}
  .sh .chip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;background:var(--code-bg);
    border:1px solid var(--border);border-radius:6px;padding:.25rem .6rem;overflow-wrap:anywhere;min-width:0}
  .sh .chip.none{font-family:inherit;color:var(--muted)}
  .sh .mv.js .mvf,.sh .mv:not(.js) .mvb{display:none}
  .sh .frm form.mvf{grid-template-columns:1fr 1fr auto;margin-top:.5rem}
  @media (max-width:30rem){.sh .frm form.mvf{grid-template-columns:1fr auto}.sh .mvf label:first-of-type{grid-column:1/-1}}
  .sh .mvf select{display:block;width:100%;margin-top:.2rem;font:inherit;font-size:.85rem;background:var(--code-bg);
    color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:.3rem .4rem}
  .sh .pick{width:min(32rem,calc(100vw - 2rem));max-height:min(32rem,calc(100vh - 4rem));box-sizing:border-box;padding:0;
    border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg);
    box-shadow:0 8px 32px rgba(0,0,0,.35)}
  .sh .pick[open]{display:flex;flex-direction:column}
  .sh .pick::backdrop{background:rgba(0,0,0,.45)}
  .sh .pick form{display:flex;flex-direction:column;align-items:stretch;flex:1;min-height:0;margin:0}
  .sh .pick .ph{display:flex;gap:.4rem;padding:.6rem;border-bottom:1px solid var(--border)}
  .sh .pick .flt{flex:1;min-width:0}
  .sh .pick .opts{overflow-y:auto;padding:.3rem;min-height:0}
  .sh .pick [role=option]{display:flex;flex-wrap:wrap;align-items:baseline;gap:.1rem .6rem;width:100%;text-align:left;
    background:none;border:0;border-radius:6px;padding:.45rem .6rem;font-weight:400}
  .sh .pick [role=option][hidden]{display:none}
  .sh .pick [role=option].on{background:var(--hover);outline:1px solid var(--border)}
  .sh .pick [role=option]:disabled{cursor:default;opacity:.7}
  .sh .pick .p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;overflow-wrap:anywhere}
  .sh .pick .none .p{font-family:inherit;font-size:.85rem;color:var(--muted)}
  .sh .pick .new{color:var(--link)}
  .sh .pick .t{color:var(--muted);font-size:.8rem;overflow-wrap:anywhere}
  .sh .pick .n{margin-left:auto;color:var(--muted);font-size:.75rem;font-variant-numeric:tabular-nums}
  .sh .pick .none{border-top:1px solid var(--border);border-radius:0 0 6px 6px;margin-top:.2rem}
  .sh .pick .hint{font-size:.75rem;color:var(--muted);margin:0;padding:0 .9rem}
  .sh .pick .hint:not(:empty){padding:.5rem .9rem}
  .app pre{width:100%;box-sizing:border-box;margin:.4rem 0 0;font-size:.78rem;white-space:pre-wrap;
    overflow-wrap:anywhere}
  .app .d-add{background:rgba(46,160,67,.18)}
  .app .d-del{background:rgba(248,81,73,.18)}
  .app .d-gap{color:var(--muted)}
  .app .tag{font-size:.7rem;border:1px solid var(--border);border-radius:5px;padding:0 .35em;color:var(--muted)}
  .app .tag.live{color:var(--acc2);border-color:var(--acc2)}
  .app form{margin:.5rem 0}
  .app button,.app .btn{font:inherit;font-size:.8rem;font-weight:500;line-height:1.5;color:var(--fg);
    background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;
    cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;vertical-align:middle}
  .app button:hover,.app .btn:hover{border-color:var(--muted)}
  .app button.pri{background:var(--link);border-color:var(--link);color:var(--bg)}
  .app button.danger{color:var(--danger);border-color:var(--danger);background:none}
  .app button.copy{display:flex;margin:0 0 .25rem auto}
  .app .ic{padding:.25rem;justify-content:center;color:var(--muted)}
  .app .ic:hover{color:var(--fg)}
  .app .ic svg{display:block;width:16px;height:16px}
  .sh .acts .ic{padding:.4rem}
  .app button:focus-visible,.app .btn:focus-visible,.app a.nm:focus-visible{outline:2px solid var(--link);outline-offset:2px}
  .app .cb{position:relative}
  .app .cb pre{margin:0;border:1px solid var(--border);padding:.6rem 3rem .6rem .8rem}
  .app .cb pre code.hljs{background:none;padding:0}
  .app .cb button.cpt{position:absolute;top:.4rem;right:.4rem;margin:0;z-index:1}
  .app button.sm,.app .btn.sm{padding:.1rem .5rem;font-size:.75rem;font-weight:400}
  .app input{font:inherit;font-size:.85rem;background:var(--code-bg);color:var(--fg);
    border:1px solid var(--border);border-radius:6px;padding:.3rem .6rem;max-width:100%;box-sizing:border-box}
  .app .box{border:1px solid var(--border);border-radius:10px;padding:.5rem 1rem;margin:1rem 0}
  .app .box p{margin:.3rem 0;font-size:.8rem;color:var(--muted)}
  #toast{position:fixed;left:50%;bottom:1.5rem;z-index:20;transform:translate(-50%,.5rem);opacity:0;
    pointer-events:none;background:var(--fg);color:var(--bg);font-size:.85rem;font-weight:500;
    padding:.4rem .9rem;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25);
    transition:opacity .15s,transform .15s}
  #toast.on{opacity:1;transform:translate(-50%,0)}
  @media (prefers-reduced-motion:reduce){#toast{transition:none}}
</style>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  var t = document.getElementById('toast'), h
  // one toast for all copy buttons; appToast is also for page scripts
  window.appToast = function (m, ms) {
    t.textContent = m; t.classList.add('on')
    clearTimeout(h); h = setTimeout(function () { t.classList.remove('on') }, ms || 1500)
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button.cp,button.cpt')
    if (!b) return
    var link = b.classList.contains('cp'), p
    try {
      p = navigator.clipboard.writeText(link ? new URL(b.getAttribute('data-u'), location.href).href
        : b.parentElement.querySelector('pre').textContent)
    } catch (err) { p = Promise.reject(err) }
    p.then(function () { appToast(link ? 'Link copied' : 'Copied') }, function () { appToast('Could not copy') })
  })
})()
</script>`

const svg = (d: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`

// Inline icons (Feather shapes), 16px, in the text colour.
export const ICON = {
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
}

// An icon button that copies url (absolute, or relative to the page).
export function copyLink(url: string) {
  return `<button type="button" class="ic cp" data-u="${esc(url)}" aria-label="Copy link" title="Copy link">${ICON.link}</button>`
}

// A link that shows only an icon; label is its accessible name and tooltip.
export function iconLink(href: string, icon: keyof typeof ICON, label: string) {
  return `<a class="btn ic" href="${esc(href)}" aria-label="${esc(label)}" title="${esc(label)}">${ICON[icon]}</a>`
}

// A code block with a copy icon button in its top right corner.
export function codeBlock(code: string) {
  return `<div class="cb"><button type="button" class="ic cpt" aria-label="Copy" title="Copy">${ICON.copy}</button><pre><code>${esc(code)}</code></pre></div>`
}

export type NavPage = 'shares' | 'collections' | 'install' | 'activity' | null

// The nav of every app page. The theme select at its end replaces the
// floating select of page(); its script fills in the stored theme.
export function nav(email: string, env: Env, current: NavPage) {
  const items: [NavPage, string, string][] = [
    ['shares', '/', 'Shares'], ['collections', '/_collections', 'Collections'], ['install', '/_token', 'Install']]
  if (email === env.ADMIN_EMAIL) items.push(['activity', '/_stats', 'Activity'])
  const links = items.map(([k, href, label]) =>
    `<a href="${href}"${k === current ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')
  const themes = ['auto', 'light', 'dark', 'tokyo', 'nord']
    .map((t) => `<option value="${t === 'auto' ? '' : t}">${t}</option>`).join('')
  return `<nav class="top">${links}<span class="me">${esc(email)}</span><select data-thm title="Theme">${themes}</select></nav>`
}

// A time as a short relative text, with the ISO time as its title.
export function when(t: number | null | undefined) {
  if (!t) return '—'
  return `<span title="${new Date(t).toISOString()}">${ago(t)}</span>`
}
