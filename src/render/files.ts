import type { Env } from '../env'
import type { ShareStore } from '../store'
import { CODE_LANGS, esc, page } from './page'

import { marked } from 'marked'
import markedFootnote from 'marked-footnote'
import { zipSync } from 'fflate'
import CLI_SH from '../bin/share' // text module (wrangler.toml rules), served at /_cli
import SKILL_MD from '../skill/SKILL.md' // ditto, served at /_skill

marked.use(markedFootnote()) // GFM [^1] footnotes
// marked-footnote drops the raw label into an aria-label attribute; strip
// labels to a safe charset so [^x" onclick=...] can't inject attributes
const fnLabel = (l: string) => l.replace(/[^\w-]/g, '_')
marked.use({
  walkTokens(t) {
    if (t.type === 'footnoteRef') t.label = fnLabel(t.label)
    if (t.type === 'footnotes') t.items.forEach((i: { label: string }) => { i.label = fnLabel(i.label) })
  },
})

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
  json: 'application/json', txt: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf', csv: 'text/csv', mp4: 'video/mp4', wasm: 'application/wasm',
  jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson',
}

function codePage(env: Env, key: string, text: string, lang?: string) {
  // page() carries hljs for all rendered pages; the class is enough
  return page(
    key.split('/').pop()!,
    `<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(text)}</code></pre>`,
    { copy: true, slug: !env.PUBLIC && key.split('/')[0] },
  )
}

// Reformat json/jsonl for display; malformed input passes through untouched.
function prettyJson(text: string, ext: string) {
  try {
    if (ext === 'json') return JSON.stringify(JSON.parse(text), null, 2)
    return text.trim().split('\n')
      .map((l) => JSON.stringify(JSON.parse(l), null, 2)).join('\n\n')
  } catch { return text }
}

// Minimal CSV parser: quoted fields, "" escapes, CRLF. No streaming (KV
// values cap at 25MB; csvPage slices input before parsing anyway).
function csvCells(text: string) {
  const rows: string[][] = [[]]
  let cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { rows.at(-1)!.push(cell); cell = '' }
    else if (c === '\n') { rows.at(-1)!.push(cell.replace(/\r$/, '')); cell = ''; rows.push([]) }
    else cell += c
  }
  rows.at(-1)!.push(cell)
  if (rows.at(-1)!.length === 1 && rows.at(-1)![0] === '') rows.pop()
  return rows
}

const MAX_CSV_ROWS = 1000

function csvPage(env: Env, key: string, text: string) {
  const clipped = text.length > 2_000_000
  const rows = csvCells(clipped ? text.slice(0, 2_000_000).replace(/\n[^\n]*$/, '') : text)
  const tr = (cells: string[], tag: string) => `<tr>${cells.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`
  const shown = rows.slice(1, MAX_CSV_ROWS + 1)
  const note = clipped || rows.length - 1 > shown.length
    ? `<p>showing first ${shown.length} rows — fetch the file directly (curl/wget) for all of it</p>` : ''
  return page(
    key.split('/').pop()!,
    `<table><thead>${tr(rows[0] || [], 'th')}</thead><tbody>${shown.map((r) => tr(r, 'td')).join('')}</tbody></table>${note}`,
    { copy: true, slug: !env.PUBLIC && key.split('/')[0] },
  )
}

// Returns a Response, or null when the key doesn't exist.
export async function render(key: string, env: Env, store: ShareStore, accept: string | null): Promise<Response | null> {
  const ext = key.split('.').pop()!.toLowerCase()
  // browsers navigating (Accept: text/html) get pretty views; fetch()/curl
  // keep getting raw bytes so html shares can load their own data files
  const wantsHtml = /text\/html/.test(accept || '')

  if (ext === 'md') {
    const md = await store.getText(key)
    if (md === null) return null
    if (!wantsHtml) {
      return new Response(md, {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'private, no-cache' },
      })
    }
    const title = md.match(/^#\s+(.+)$/m)?.[1] ?? key
    return page(title, marked.parse(md, { async: false }), { copy: true, slug: !env.PUBLIC && key.split('/')[0] })
  }

  if (wantsHtml && ['json', 'jsonl', 'ndjson', 'csv'].includes(ext)) {
    const text = await store.getText(key)
    if (text === null) return null
    if (ext === 'csv') return csvPage(env, key, text)
    return codePage(env, key, prettyJson(text, ext), 'json')
  }

  if (TYPES[ext]) {
    const body = await store.getStream(key)
    if (body === null) return null
    return new Response(body, {
      headers: { 'content-type': TYPES[ext], 'cache-control': 'private, no-cache' },
    })
  }

  // Unknown extension: text renders as a highlighted <pre> page; binary
  // content (null byte early on) and non-browser requests get raw bytes.
  const buf = await store.getBytes(key)
  if (buf === null) return null
  const binary = new Uint8Array(buf, 0, Math.min(8192, buf.byteLength)).includes(0)
  if (binary || !wantsHtml) {
    return new Response(buf, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-cache' },
    })
  }
  return codePage(env, key, new TextDecoder().decode(buf), CODE_LANGS[ext])
}
