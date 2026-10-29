// The `share` CLI. Same commands as the bash CLI (bin/share) plus login,
// logout, whoami, log and --json. API shapes: src/api-types.ts.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type {
  DeviceStartResponse, DeviceTokenResponse, PublishRequest, PublishResponse, ServiceTokenCreate, ServiceTokenCreated,
  ServiceTokenInfo, TokenInfo, VersionInfo, WhoAmI,
} from '../src/api-types'
import { filePathUrl, parseLines, parseViews } from '../src/api-types'
import { DEFAULT_APP, loadConfig, updateConfig, type Config } from './config'
import { collect, defaultName, deslug, localCopy, localPath, mirror, randomSuffix, readBytes, sha256, type LocalFile } from './files'
import { client, HttpError, pool, sleep, UsageError, type Client } from './http'

declare const SHARE_VERSION: string
export const VERSION = typeof SHARE_VERSION === 'string' ? SHARE_VERSION : 'dev'

const PARALLEL = 8

export const HELP = `usage: share <file-or-dir> [name]        publish (new slug w/ random suffix)
       share <files...>                  glob form: one share named for parent dir
       share -e <file-or-dir> <slug>     overwrite existing share (same URL)
       share -x <file-or-dir> <name>     exact slug, no random suffix (fails if taken)
       ... | share [-e] -f <name> [slug] publish stdin as file <name>
       share rm <url-or-slug>            delete a share (local mirror copy stays)
       share download <url-or-slug> [dest]  pull a share's files into dest/ (default: slug/)
       share cat <url-or-slug>[/file]    print share contents to stdout (URL ok as-is)
       share ls <url-or-slug>            list files in a share
       share log <url-or-slug>           versions of a share, newest first
       share --local <url-or-slug>[/file]  print the local path a share came from
       share views <url-or-slug>         who viewed a share (email, count, last)
       share login [app-url]             approve a new token in the browser, save it
       share logout                      revoke this machine's token
       share whoami                      the account of the saved token
       share public <url-or-slug> on|off  open a share without login (if the server allows it)
       share -p|--public <file-or-dir> ...  publish, then make it public
       share api <path>                  GET /_api/<path> as JSON (collections, shares, versions)
       share token ls [--service]        your CLI tokens (admin, --service: service tokens)
       share token create <name> --scope <scope>... [--on-behalf-of <email>] [--days <n>]
                                         admin: a service token for an agent or CI, shown once
       share token revoke <id> [--service]  revoke a token
       share                             list all shares

publish options:
  -c, --collection <slug>   publish into a collection (made if missing)
  -t, --title <text>        share title
  -m, --meta <key=value>    share metadata, repeatable
      --message <text>      version message (shown by \`share log\`)
token options:
      --scope <scope>       read:<collection> or write:<collection>, a trailing *
                            matches any rest (write:metareview/*); repeatable
      --on-behalf-of <email>  the person who owns the shares the token makes
      --days <n>            expiry, 1 to 365 (default 365)
global options:
      --json                one JSON value on stdout (errors too: {"error": ...})
  -V, --version             print the version

examples:
  share thing.md                   publish file -> prints URL instantly
  share ./some-dir                 publish whole directory
  share ./dir cool-name            custom name (still gets random suffix)
  share -x report.md standup       exact memorable URL: /standup/ (guessable!)
  pbpaste | share -f slides.html   stdin; .html/.md becomes the share's index
  share -e ./dir cool-name-a3f2b   overwrite existing share, same URL
  share cat https://…/report-a3f2b/   read a pasted share URL (agent-friendly)
  share --json ./out | jq -r .url  scripts and agents
  share --collection metareview/pr-85416 --meta pr=85416 --title "Run 1" ./out
                                   publish into a collection with metadata
  share api 'shares?collection=metareview/pr-85416&meta.pr=85416'

Viewers need a @metabase.com Google login; URLs are safe to paste anywhere.
A single .md/.html file publishes as the share's index (remote name
index.md/index.html) so the slug URL renders it directly. file:// URLs work
as publish paths. Every publish also lands in ~/.local/share/mb-shares/<slug>/
(MIRROR_DIR in the config overrides it); -e replaces that copy, rm leaves it.
Config: ~/.config/shares/config (mode 0600), written by \`share login\`.
SHARES_URL, SHARES_CONTENT_URL and SHARES_TOKEN in the environment override it.
`

const COMMANDS = new Set(['login', 'logout', 'whoami', 'rm', 'ls', 'cat', 'download', 'views', 'log', 'public', 'api', 'local', 'help', 'version', 'token'])

export interface Opts {
  json: boolean
  edit: boolean
  exact: boolean
  public: boolean
  filename?: string
  collection?: string
  title?: string
  meta: Record<string, string>
  message?: string
  service: boolean
  scopes: string[]
  onBehalfOf?: string
  days?: number
}

export interface Io {
  stdout: (s: string | Uint8Array) => void
  stderr: (s: string) => void
  stdin: () => Promise<Uint8Array>
  env: Record<string, string | undefined>
  cwd: string
}

export function parseArgs(argv: string[]): { opts: Opts; args: string[] } {
  const opts: Opts = { json: false, edit: false, exact: false, public: false, meta: {}, service: false, scopes: [] }
  const args: string[] = []
  const value = (i: number, flag: string) => {
    const v = argv[i + 1]
    if (v === undefined) throw new UsageError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { args.push(...argv.slice(i + 1)); break }
    switch (a) {
      case '--json': opts.json = true; break
      case '-e': case '--edit': opts.edit = true; break
      case '-x': case '--exact': opts.exact = true; break
      case '-p': case '--public': opts.public = true; break
      case '-h': case '--help': args.unshift('help'); break
      case '-V': case '--version': args.unshift('version'); break
      case '--local': args.unshift('local'); break
      case '-f': case '--filename': opts.filename = value(i++, a); break
      case '-c': case '--collection': opts.collection = value(i++, a); break
      case '-t': case '--title': opts.title = value(i++, a); break
      case '--message': opts.message = value(i++, a); break
      case '--service': opts.service = true; break
      case '--scope': opts.scopes.push(value(i++, a)); break
      case '--on-behalf-of': opts.onBehalfOf = value(i++, a); break
      case '--days': {
        const n = Number(value(i++, a))
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--days takes a whole number of days')
        opts.days = n
        break
      }
      case '-m': case '--meta': {
        const kv = value(i++, a)
        const j = kv.indexOf('=')
        if (j < 1) throw new UsageError('usage: --meta key=value')
        opts.meta[kv.slice(0, j)] = kv.slice(j + 1)
        break
      }
      default:
        if (a.startsWith('-') && a.length > 1) throw new UsageError(`unknown option ${a} (share -h)`)
        args.push(a)
    }
  }
  return { opts, args }
}

const enc = encodeURIComponent

class Ctx {
  constructor(readonly io: Io, readonly opts: Opts, readonly cfg: Config) {}

  // human output; --json prints only the final value
  say(s: string) { if (!this.opts.json) this.io.stdout(s.endsWith('\n') ? s : s + '\n') }
  note(s: string) { this.io.stderr(s.endsWith('\n') ? s : s + '\n') }
  emit(v: unknown) { if (this.opts.json) this.io.stdout(JSON.stringify(v) + '\n') }

  get api(): Client {
    if (!this.cfg.baseUrl || !this.cfg.token) {
      throw new UsageError(`not logged in: run \`share login\` (config ${this.cfg.path})`)
    }
    return client(this.cfg.baseUrl, this.cfg.token)
  }

  get contentBase() { return this.cfg.contentUrl || this.cfg.baseUrl! }

  async files(slug: string): Promise<string[]> {
    return parseLines(await this.api.text('GET', `/_list?prefix=${enc(slug + '/')}`))
  }

  async exists(slug: string) {
    try { return (await this.files(slug)).length > 0 } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false
      throw e
    }
  }

  async shareFiles(slug: string) {
    const fs = await this.files(slug)
    if (!fs.length) throw new Error(`no share '${slug}' (run \`share\` to list)`)
    return fs
  }

  // raw bytes of one share file; path = "<slug>/<file>"
  async bytes(path: string) {
    const res = await this.api.request('GET', filePathUrl('', path))
    if (!res.ok) throw new HttpError(res.status, await res.text(), `GET /${path}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

const need = (v: string | undefined, usage: string) => {
  if (!v) throw new UsageError(`usage: ${usage}`)
  return v
}

export async function main(argv: string[], io: Io): Promise<number> {
  let json = argv.includes('--json')
  try {
    const { opts, args } = parseArgs(argv)
    json = opts.json
    const ctx = new Ctx(io, opts, loadConfig(io.env))
    const [cmd, ...rest] = args
    if (cmd !== undefined && COMMANDS.has(cmd)) await run(ctx, cmd, rest)
    else if (cmd === undefined) await list(ctx)
    else await publish(ctx, args)
    return 0
  } catch (e) {
    const msg = (e as Error).message
    if (json) io.stdout(JSON.stringify({ error: msg, ...(e instanceof HttpError ? { status: e.status } : {}) }) + '\n')
    io.stderr(`share: ${msg}\n`)
    return e instanceof UsageError ? 2 : 1
  }
}

async function run(ctx: Ctx, cmd: string, a: string[]) {
  switch (cmd) {
    case 'help': ctx.io.stdout(HELP); return
    case 'version': ctx.say(`share ${VERSION}`); ctx.emit({ version: VERSION }); return
    case 'login': return login(ctx, a[0])
    case 'token': return token(ctx, a)
    case 'logout': return logout(ctx)
    case 'whoami': {
      const w = await ctx.api.json<WhoAmI>('GET', '/_api/whoami')
      ctx.say(w.kind === 'service'
        ? `${w.agent} (service token, ${w.scopes?.join(',')}; shares owned by ${w.email}) on ${ctx.cfg.baseUrl}`
        : `${w.email}${w.admin ? ' (admin)' : ''} on ${ctx.cfg.baseUrl}`)
      ctx.emit({ ...w, base_url: ctx.cfg.baseUrl, content_url: ctx.contentBase })
      return
    }
    case 'local': {
      const arg = deslug(need(a[0], 'share --local <url-or-slug>[/file]'))
      const p = localCopy(ctx.cfg.mirrorDir, arg)
      if (!p) throw new Error(`no local copy of '${arg.split('/')[0]}' (published from another machine?)`)
      ctx.say(p)
      ctx.emit({ path: p })
      return
    }
    case 'api': {
      const path = need(a[0], 'share api <path>').replace(/^\/+/, '')
      const text = await ctx.api.text('GET', `/_api/${path}`)
      ctx.io.stdout(text.endsWith('\n') ? text : text + '\n')
      return
    }
    case 'views': {
      const slug = deslug(need(a[0], 'share views <url-or-slug>'))
      const views = parseViews(await ctx.api.text('GET', `/${enc(slug)}/_views`))
      if (!views.length && !ctx.opts.json) ctx.note('no views yet')
      else ctx.say(table(views.map((v) => [v.email, String(v.count), v.last])))
      ctx.emit(views)
      return
    }
    case 'log': {
      const slug = deslug(need(a[0], 'share log <url-or-slug>'))
      const vs = await ctx.api.json<VersionInfo[]>('GET', `/_api/shares/${enc(slug)}/versions`)
      ctx.say(table(vs.map((v) => [
        `v${v.version}`, v.live ? 'live' : v.state === 'pending' ? 'pending' : '', v.createdBy,
        new Date(v.createdAt).toISOString().replace('T', ' ').slice(0, 16),
        `${v.fileCount} file${v.fileCount === 1 ? '' : 's'}`, size(v.totalBytes), v.message ?? '',
      ])))
      ctx.emit(vs)
      return
    }
    case 'public': {
      const slug = deslug(need(a[0], 'share public <url-or-slug> on|off'))
      const v = a[1]
      if (v !== 'on' && v !== 'off') throw new UsageError('usage: share public <url-or-slug> on|off')
      ctx.say((await ctx.api.text('POST', `/_public/${enc(slug)}`, { body: v })).trim())
      ctx.emit({ slug, public: v === 'on' })
      return
    }
    case 'rm': {
      const slug = deslug(need(a[0], 'share rm <url-or-slug>'))
      if (!slug || slug.includes('/')) throw new UsageError('usage: share rm <url-or-slug> (a whole share, not a file)')
      const out = (await ctx.api.text('DELETE', `/${enc(slug)}/`)).trim()
      ctx.say(out)
      ctx.emit({ slug, deleted: Number(out.replace(/^deleted /, '')) || 0 })
      return
    }
    case 'ls': {
      const slug = deslug(need(a[0], 'share ls <url-or-slug>'))
      const files = (await ctx.shareFiles(slug)).map((k) => k.slice(slug.length + 1))
      ctx.say(files.join('\n'))
      ctx.emit(files)
      return
    }
    case 'cat': {
      const arg = deslug(need(a[0], 'share cat <url-or-slug>[/file]'))
      const keys = arg.includes('/') ? [arg] : await ctx.shareFiles(arg)
      const dec = new TextDecoder()
      const out: { path: string; content: string }[] = []
      for (const k of keys) {
        const b = await ctx.bytes(k)
        if (ctx.opts.json) { out.push({ path: k, content: dec.decode(b) }); continue }
        if (keys.length > 1) ctx.io.stdout(`==> ${k.slice(arg.length + 1)} <==\n`)
        ctx.io.stdout(b)
        if (keys.length > 1) ctx.io.stdout('\n')
      }
      ctx.emit(out)
      return
    }
    case 'download': {
      const slug = deslug(need(a[0], 'share download <url-or-slug> [dest]'))
      const dest = a[1] ?? slug
      const keys = await ctx.shareFiles(slug)
      const done: string[] = []
      await pool(keys, PARALLEL, async (k) => {
        const rel = k.slice(slug.length + 1)
        const b = await ctx.bytes(k)
        const p = join(ctx.io.cwd, dest, rel)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, b)
        done.push(rel)
      })
      ctx.note(`downloaded ${done.length} file(s) to ${dest}/`)
      ctx.emit({ slug, dest, files: done.sort() })
      return
    }
  }
}

// CLI tokens: your own, or (admin, --service) service tokens (decision
// service-tokens-scopes)
async function token(ctx: Ctx, a: string[]) {
  const usage = 'share token ls|create|revoke (share -h)'
  const kind = ctx.opts.service ? '?kind=service' : ''
  const day = (t: number | null) => t ? new Date(t).toISOString().slice(0, 10) : ''
  switch (a[0]) {
    case 'ls': case 'list': {
      const ts = await ctx.api.json<(TokenInfo & Partial<ServiceTokenInfo>)[]>('GET', `/_api/tokens${kind}`)
      ctx.say(table(ts.map((t) => [
        t.id, t.name, t.revoked_at ? 'revoked' : t.expires_at && t.expires_at <= Date.now() ? 'expired' : `expires ${day(t.expires_at)}`,
        t.last_used_at ? `used ${day(t.last_used_at)}` : 'never used',
        ...(t.scopes ? [t.scopes.join(','), t.on_behalf_of ?? ''] : []),
      ])))
      ctx.emit(ts)
      return
    }
    case 'create': {
      const name = need(a[1], 'share token create <name> --scope <scope>...')
      if (!ctx.opts.scopes.length) throw new UsageError('a service token needs at least one --scope')
      const body: ServiceTokenCreate = {
        name, scopes: ctx.opts.scopes,
        ...(ctx.opts.onBehalfOf !== undefined && { on_behalf_of: ctx.opts.onBehalfOf }),
        ...(ctx.opts.days !== undefined && { expires_days: ctx.opts.days }),
      }
      const t = await ctx.api.json<ServiceTokenCreated>('POST', '/_api/tokens', { json: body })
      ctx.say(t.token)
      if (!ctx.opts.json) ctx.note(`service token ${t.id} (agent:${t.name}, ${t.scopes.join(',')}); shown once. Use: SHARES_TOKEN=<token> SHARES_URL=${ctx.cfg.baseUrl} share ...`)
      ctx.emit({ ...t, base_url: ctx.cfg.baseUrl, content_url: ctx.contentBase })
      return
    }
    case 'revoke': case 'rm': {
      const id = need(a[1], 'share token revoke <id> [--service]')
      const r = await ctx.api.json<{ revoked: string }>('DELETE', `/_api/tokens/${enc(id)}${kind}`)
      ctx.say(`revoked ${r.revoked}`)
      ctx.emit(r)
      return
    }
    default: throw new UsageError(`usage: ${usage}`)
  }
}

async function list(ctx: Ctx) {
  const slugs = parseLines(await ctx.api.text('GET', '/_list'))
  ctx.say(slugs.join('\n'))
  ctx.emit(slugs)
}

async function publish(ctx: Ctx, args: string[]) {
  const { opts, io } = ctx
  const api = ctx.api
  let tmp: string | undefined
  try {
    if (opts.filename) {
      if (opts.filename.includes('/')) throw new UsageError('-f takes a file name, not a path')
      tmp = mkdtempSync(join(tmpdir(), 'share-'))
      const p = join(tmp, opts.filename)
      writeFileSync(p, await io.stdin())
      args = [p, ...args]
    }
    if (!args.length) throw new UsageError('usage: share [-e] <file-or-dir> [name]')
    const src = localPath(args[0], io.cwd)
    // glob form (`share dir/*`): the second arg is an existing path too
    const multi = args.length > 1 && existsSync(localPath(args[1], io.cwd))
    const srcs = multi ? args.map((s) => localPath(s, io.cwd)) : [src]
    let name = (multi ? basename(dirname(src)) : args[1] ?? defaultName(src)).replace(/ /g, '-')
    const files = collect(srcs)
    if (!files.length) throw new Error(`no files found under ${src} -- nothing uploaded`)

    if (opts.edit) {
      if (!await ctx.exists(name)) throw new Error(`no existing share '${name}' (run \`share\` to list); omit -e to create new`)
    } else if (opts.exact) {
      if (await ctx.exists(name)) throw new Error(`share '${name}' already exists (yours? overwrite with -e)`)
    } else {
      name = `${name}-${randomSuffix()}`
    }

    const url = `${ctx.contentBase}/${enc(name)}/`
    ctx.say(url)
    mirror(ctx.cfg.mirrorDir, name, files, multi ? dirname(src) : src, opts.edit)

    const version = await upload(api, name, files, opts)
    if (opts.public) {
      try {
        await api.text('POST', `/_public/${enc(name)}`, { body: 'on' })
      } catch (e) {
        throw new Error(`uploaded, but could not make it public (${(e as Error).message})`)
      }
    }
    if (!opts.json) ctx.note(opts.public ? 'uploaded (public: opens without login)' : 'uploaded')
    ctx.emit({ url, slug: name, version, files: files.map((f) => f.path), public: opts.public })
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

// Versioned publish (POST /_blobs/missing, PUT /_blobs/<sha>, POST
// /_publish/<slug>); the KV store answers 501 and gets the legacy PUT +
// finalize. Returns the new version, null on the legacy path.
async function upload(api: Client, slug: string, files: LocalFile[], opts: Opts): Promise<number | null> {
  const blobs = files.map((f) => {
    const data = readBytes(f.src)
    return { ...f, data, sha256: sha256(data) }
  })
  let missing: Set<string>
  try {
    missing = new Set(parseLines(await api.text('POST', '/_blobs/missing',
      { body: [...new Set(blobs.map((b) => b.sha256))].join('\n') + '\n' })))
  } catch (e) {
    if (e instanceof HttpError && e.status === 501) return legacyUpload(api, slug, blobs, opts)
    throw e
  }
  const todo = blobs.filter((b) => missing.delete(b.sha256))
  await pool(todo, PARALLEL, async (b) => { await api.text('PUT', `/_blobs/${b.sha256}`, { body: b.data }) })

  const req: PublishRequest = {
    files: blobs.map((b) => ({ path: b.path, sha256: b.sha256 })),
    ...(opts.collection !== undefined && { collection: opts.collection }),
    ...(opts.title !== undefined && { title: opts.title }),
    ...(Object.keys(opts.meta).length && { meta: opts.meta }),
    ...(opts.message !== undefined && { message: opts.message }),
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return (await api.json<PublishResponse>('POST', `/_publish/${enc(slug)}`, { json: req })).version
    } catch (e) {
      // 409: a concurrent publish to the same slug won the version number
      if (e instanceof HttpError && e.status === 409 && attempt < 3) { await sleep(200 * (attempt + 1)); continue }
      throw e
    }
  }
}

async function legacyUpload(api: Client, slug: string, blobs: (LocalFile & { data: Uint8Array<ArrayBuffer> })[], opts: Opts) {
  await pool(blobs, PARALLEL, async (b) => { await api.text('PUT', filePathUrl('', `${slug}/${b.path}`), { body: b.data }) })
  const q = new URLSearchParams()
  if (opts.collection !== undefined) q.set('collection', opts.collection)
  if (opts.title !== undefined) q.set('title', opts.title)
  for (const [k, v] of Object.entries(opts.meta)) q.append('meta', `${k}=${v}`)
  const qs = q.size ? `?${q}` : ''
  await api.text('POST', `/_finalize/${enc(slug)}${qs}`, { body: blobs.map((b) => b.path).join('\n') + '\n' })
  return null
}

// device flow (decision cli-tokens-device-flow): the app host shows a code,
// a signed-in user approves it, this polls until the token comes
async function login(ctx: Ctx, arg?: string) {
  const base = (arg || ctx.io.env.SHARES_URL || ctx.cfg.baseUrl || DEFAULT_APP).replace(/\/+$/, '')
  const anon = client(base)
  const host = (() => { try { return hostname().split('.')[0] } catch { return 'unknown' } })()
  const start = await anon.json<DeviceStartResponse>('POST', '/_device/code', { json: { name: `share cli on ${host}` }, auth: false })
  ctx.note(`code: ${start.user_code}`)
  ctx.note(`approve it at: ${start.verification_uri_complete}`)
  if (!ctx.io.env.SHARE_NO_BROWSER) openBrowser(start.verification_uri_complete)

  let interval = start.interval
  const deadline = Date.now() + start.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const res = await anon.request('POST', '/_device/token', { json: { device_code: start.device_code }, auth: false })
    const text = await res.text()
    let r: DeviceTokenResponse | { error: string }
    try { r = JSON.parse(text) } catch { throw new Error(`login failed: ${res.status} ${text.trim()}`) }
    if ('error' in r) {
      if (r.error === 'authorization_pending') continue
      if (r.error === 'slow_down') { interval += 5; continue }
      if (r.error === 'access_denied') throw new Error('denied in the browser; no token was created')
      if (r.error === 'expired_token') break
      throw new Error(`login failed: ${r.error}`)
    }
    const path = ctx.io.env.SHARE_CONF || join(ctx.io.env.HOME || '', '.config/shares/config')
    updateConfig(path, { BASE_URL: start.base_url, CONTENT_URL: start.content_url, UPLOAD_TOKEN: r.token })
    ctx.note(`logged in as ${r.email}; token saved to ${path}`)
    ctx.emit({ email: r.email, name: r.name, base_url: start.base_url, content_url: start.content_url, config: path })
    return
  }
  throw new Error('code expired; run `share login` again')
}

async function logout(ctx: Ctx) {
  if (!ctx.cfg.token) throw new Error('not logged in')
  let revoked = true
  try {
    await ctx.api.text('DELETE', '/_api/tokens/current')
  } catch (e) {
    revoked = false
    ctx.note(`the server did not revoke the token (${(e as Error).message}); removing it here`)
  }
  updateConfig(ctx.cfg.path, { UPLOAD_TOKEN: undefined })
  ctx.note(revoked ? 'logged out; token revoked' : 'logged out')
  ctx.emit({ revoked, config: ctx.cfg.path })
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try {
    const p = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    p.on('error', () => {})
    p.unref()
  } catch { /* no browser: the URL is printed */ }
}

// columns padded to their widest cell, two spaces apart; last column ragged
function table(rows: string[][]) {
  const w = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? []
  return rows.map((r) => r.map((c, i) => i < r.length - 1 ? c.padEnd(w[i]) : c).join('  ').trimEnd()).join('\n')
}

function size(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
