// Local side of a publish: which files go into a share under which paths,
// slugs, the local mirror and its .sources record.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LocalFile {
  // absolute source path
  src: string
  // path inside the share
  path: string
}

// A pasted share URL works anywhere a slug does: drop scheme://host/ and
// the trailing /
export function deslug(arg: string): string {
  let a = arg
  const i = a.indexOf('://')
  if (i >= 0) {
    a = a.slice(i + 3)
    const j = a.indexOf('/')
    a = j >= 0 ? a.slice(j + 1) : ''
  }
  a = a.replace(/[?#].*$/, '').replace(/\/+$/, '')
  return a.split('/').map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
}

// file:// URLs (drag and drop, "Copy as URL") and paths relative to cwd
export function localPath(arg: string, cwd: string): string {
  return arg.startsWith('file://') ? fileURLToPath(arg) : resolve(cwd, arg)
}

export const randomSuffix = () => randomBytes(3).toString('hex')

// Default share name: the file name without extension, or the dir name.
// Spaces become dashes.
export function defaultName(src: string): string {
  const b = basename(src)
  const n = statSync(src).isFile() && extname(b) ? b.slice(0, -extname(b).length) : b
  return n.replace(/ /g, '-')
}

// every file under dir, symlinks followed, .git skipped; paths relative to dir
export function walk(dir: string, rel = ''): LocalFile[] {
  const out: LocalFile[] = []
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name
    const abs = join(dir, r)
    let st
    try { st = statSync(abs) } catch { continue } // dangling symlink
    if (st.isDirectory()) {
      if (name !== '.git') out.push(...walk(dir, r))
    } else if (st.isFile()) {
      out.push({ src: abs, path: r })
    }
  }
  return out
}

// The files of a publish. One path: a single .md/.html file becomes the
// share's index, another file keeps its name, a dir publishes its tree.
// Several paths (the glob form, `share dir/*`): files at the top level,
// dirs under their own name.
export function collect(srcs: string[]): LocalFile[] {
  for (const s of srcs) if (!existsSync(s)) throw new Error(`no such path: ${s}`)
  if (srcs.length === 1) {
    const s = srcs[0]
    if (statSync(s).isDirectory()) return walk(s)
    const b = basename(s)
    const path = b.endsWith('.md') ? 'index.md' : b.endsWith('.html') ? 'index.html' : b
    return [{ src: s, path }]
  }
  const out: LocalFile[] = []
  for (const s of srcs) {
    if (statSync(s).isDirectory()) {
      out.push(...walk(s).map((f) => ({ src: f.src, path: `${basename(s)}/${f.path}` })))
    } else {
      out.push({ src: s, path: basename(s) })
    }
  }
  return out
}

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

export const readBytes = (src: string) => new Uint8Array(readFileSync(src))

// The mirror keeps a copy of each share's current content at
// <mirror>/<slug>/<path>; .sources maps slug to the source path (last
// line wins) for `share --local`.
export function mirror(mirrorDir: string, slug: string, files: LocalFile[], source: string, replace: boolean) {
  const root = join(mirrorDir, slug)
  if (replace) rmSync(root, { recursive: true, force: true })
  for (const f of files) {
    const dst = join(root, f.path)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(f.src, dst)
  }
  mkdirSync(mirrorDir, { recursive: true })
  appendFileSync(join(mirrorDir, '.sources'), `${slug}\t${source}\n`)
}

// `share --local <slug>[/file]`: the source path, else the mirror copy, else null
export function localCopy(mirrorDir: string, arg: string): string | null {
  const top = arg.split('/')[0]
  const rest = arg.slice(top.length)
  let src = ''
  try {
    for (const line of readFileSync(join(mirrorDir, '.sources'), 'utf8').split('\n')) {
      const [s, p] = line.split('\t')
      if (s === top && p) src = p
    }
  } catch { /* no .sources yet */ }
  if (src && existsSync(src)) return statSync(src).isDirectory() ? src + rest : src
  const m = join(mirrorDir, arg)
  return existsSync(m) ? m : null
}
