// The CLI against `wrangler dev` (local D1 + R2, combined host). Runs the
// source with bun, or the binary in SHARE_BIN. SHARE_DIST (a dir with the
// release files of cli/build.ts) adds the install.sh test. E2E_HOST: the
// host name the CLI uses for the worker (host.docker.internal when
// SHARE_BIN runs a Linux binary in a container); the test itself uses
// localhost.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const PORT = 20000 + Math.floor(Math.random() * 20000)
const BASE = `http://${process.env.E2E_HOST || 'localhost'}:${PORT}`
const LOCAL = `http://localhost:${PORT}`
// a URL that the CLI printed, as the test reaches it
const local = (u: string) => u.replace(BASE, LOCAL)
const SECRET = 'e2e-session-secret'
const ADMIN_TOKEN = 'e2e-upload-token'
const USER = 'e2e-user@metabase.com'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'share-e2e-')))
const HOME = join(dir, 'home')
mkdirSync(HOME)
let worker: ChildProcess

interface Run { code: number; stdout: string; stderr: string }

type RunOpts = { stdin?: string; env?: Record<string, string>; cwd?: string }

const share = (args: string[], opts: RunOpts = {}) => start(args, opts).done

// a running CLI; err() is its stderr so far
function start(args: string[], opts: RunOpts = {}) {
  const [cmd, pre] = process.env.SHARE_BIN ? [process.env.SHARE_BIN, []] : ['bun', [join(ROOT, 'cli/share.ts')]]
  const p = spawn(cmd, [...pre, ...args], {
    cwd: opts.cwd ?? dir,
    env: { PATH: process.env.PATH, HOME, SHARE_NO_BROWSER: '1', ...opts.env },
  })
  let stdout = ''
  let stderr = ''
  p.stdout.on('data', (d) => { stdout += d })
  p.stderr.on('data', (d) => { stderr += d })
  p.stdin.end(opts.stdin ?? '')
  const done = new Promise<Run>((r) => p.on('close', (code) => r({ code: code ?? -1, stdout, stderr })))
  return { done, err: () => stderr }
}

// the session cookie of src/auth.ts signEmail (tag '')
function session(email: string) {
  const e = Buffer.from(email).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + 3600
  return `s=${e}.${exp}.${createHmac('sha256', SECRET).update(`${e}.${exp}`).digest('base64url')}`
}

async function approve(code: string) {
  const res = await fetch(`${LOCAL}/_device`, {
    method: 'POST',
    headers: { cookie: session(USER), origin: LOCAL, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, action: 'approve' }),
  })
  expect(res.status).toBe(200)
}

beforeAll(async () => {
  const state = join(dir, 'state')
  const wr = join(ROOT, 'node_modules/.bin/wrangler')
  const m = spawnSync(wr, ['d1', 'migrations', 'apply', 'shares', '--local', '--persist-to', state], {
    cwd: ROOT, env: { ...process.env, CI: '1' }, encoding: 'utf8',
  })
  if (m.status !== 0) throw new Error(`migrations: ${m.stderr}`)
  worker = spawn(wr, ['dev', '--port', String(PORT), '--ip', process.env.E2E_HOST ? '0.0.0.0' : '127.0.0.1', '--persist-to', state,
    '--var', `SESSION_SECRET:${SECRET}`, '--var', `UPLOAD_TOKEN:${ADMIN_TOKEN}`, '--var', 'PUBLIC_SHARING:1'], {
    cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${LOCAL}/_skill`)).ok) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('wrangler dev did not start')
})

afterAll(() => { worker?.kill() })

describe('share CLI against wrangler dev', () => {
  it('logs in with the device flow and saves the config', async () => {
    const p = start(['login', BASE, '--json'])
    // the approve page takes the code that login printed
    let code = ''
    for (let i = 0; i < 200 && !code; i++) {
      await new Promise((r) => setTimeout(r, 50))
      code = /code: (\w{4}-\w{4})/.exec(p.err())?.[1] ?? ''
    }
    await approve(code)
    const r = await p.done
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ email: USER, base_url: BASE })
    const conf = readFileSync(join(HOME, '.config/shares/config'), 'utf8')
    expect(conf).toMatch(/^UPLOAD_TOKEN=shr_/m)

    const w = await share(['whoami', '--json'])
    expect(JSON.parse(w.stdout)).toMatchObject({ kind: 'user', email: USER, admin: false })
  })

  it('publishes a file and prints a URL that serves it', async () => {
    writeFileSync(join(dir, 'x.md'), '# hello e2e\n')
    const r = await share(['x.md'])
    expect(r.code).toBe(0)
    const url = r.stdout.trim()
    expect(url).toMatch(new RegExp(`^${BASE}/x-[0-9a-f]{6}/$`))
    const page = await fetch(local(url), { headers: { cookie: session(USER), accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('hello e2e')
  })

  it('republishes with -e, lists versions with log, reads back with ls and cat', async () => {
    mkdirSync(join(dir, 'site/sub'), { recursive: true })
    writeFileSync(join(dir, 'site/index.html'), '<h1>v1</h1>')
    writeFileSync(join(dir, 'site/sub/data.csv'), 'a,b\n1,2\n')
    const first = JSON.parse((await share(['--json', 'site', 'my site', '--message', 'first'])).stdout)
    expect(first).toMatchObject({ version: 1, files: ['index.html', 'sub/data.csv'] })
    expect(first.slug).toMatch(/^my-site-[0-9a-f]{6}$/)

    writeFileSync(join(dir, 'site/index.html'), '<h1>v2</h1>')
    const second = JSON.parse((await share(['-e', '--json', 'site', first.url])).stdout)
    expect(second).toMatchObject({ slug: first.slug, version: 2, url: first.url })

    const log = JSON.parse((await share(['log', first.url, '--json'])).stdout)
    expect(log.map((v: { version: number; live: boolean }) => [v.version, v.live])).toEqual([[2, true], [1, false]])
    expect((await share(['log', first.slug])).stdout).toMatch(/^v2\s+live/)

    expect((await share(['ls', first.slug])).stdout).toBe('index.html\nsub/data.csv\n')
    expect((await share(['cat', `${first.url}index.html`])).stdout).toBe('<h1>v2</h1>')
    expect((await share(['cat', first.slug])).stdout).toContain('==> sub/data.csv <==\na,b\n1,2\n')

    const dl = await share(['download', first.slug, 'out', '--json'])
    expect(JSON.parse(dl.stdout).files).toEqual(['index.html', 'sub/data.csv'])
    expect(readFileSync(join(dir, 'out/sub/data.csv'), 'utf8')).toBe('a,b\n1,2\n')

    expect((await share(['--local', first.slug])).stdout.trim()).toBe(join(dir, 'site'))
    expect(readFileSync(join(HOME, `.local/share/mb-shares/${first.slug}/index.html`), 'utf8')).toBe('<h1>v2</h1>')
  })

  it('publishes stdin with -f, exact slugs with -x, and refuses a taken one', async () => {
    const name = `exact-${PORT}`
    const r = await share(['-x', '-f', 'notes.txt', name], { stdin: 'from stdin' })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(`${BASE}/${name}/`)
    expect((await share(['cat', `${name}/notes.txt`])).stdout).toBe('from stdin')
    const again = await share(['-x', 'x.md', name, '--json'])
    expect(again.code).toBe(1)
    expect(JSON.parse(again.stdout).error).toMatch(/already exists/)
    expect((await share(['-e', 'x.md', 'no-such-share-zz'])).stderr).toMatch(/no existing share/)
  })

  it('publishes into a collection, makes a share public, lists, shows views, removes', async () => {
    const p = JSON.parse((await share(['--json', '-p', '-c', 'e2e/run-1', '-t', 'Run 1', '-m', 'pr=7', 'x.md'])).stdout)
    expect(p.public).toBe(true)
    const info = JSON.parse((await share(['api', `shares/${p.slug}`])).stdout)
    expect(info).toMatchObject({ collection: 'e2e/run-1', title: 'Run 1', meta: { pr: '7' } })
    expect(await (await fetch(`${LOCAL}/${p.slug}/`)).text()).toContain('hello e2e')

    expect(JSON.parse((await share(['--json'])).stdout)).toContain(p.slug)
    await fetch(local(p.url), { headers: { cookie: session(USER), accept: 'text/html' } })
    const views = JSON.parse((await share(['views', p.slug, '--json'])).stdout)
    expect(views[0]).toMatchObject({ email: USER, count: 1 })

    expect(JSON.parse((await share(['rm', p.url, '--json'])).stdout)).toMatchObject({ slug: p.slug })
    expect((await share(['ls', p.slug])).code).toBe(1)
  })

  it('creates a service token that publishes only into its collections', async () => {
    const admin = { SHARES_TOKEN: ADMIN_TOKEN, SHARES_URL: BASE }
    const t = JSON.parse((await share(['token', 'create', 'e2e-bot', '--scope', 'write:bots/*', '--on-behalf-of', USER, '--json'], { env: admin })).stdout)
    expect(t.token).toMatch(/^shr_/)
    const bot = { SHARES_TOKEN: t.token, SHARES_URL: BASE }
    expect(JSON.parse((await share(['whoami', '--json'], { env: bot })).stdout))
      .toMatchObject({ kind: 'service', agent: 'agent:e2e-bot', email: USER, scopes: ['write:bots/*'] })
    const ok = await share(['--json', '-c', 'bots/a', 'x.md'], { env: bot })
    expect(JSON.parse(ok.stdout)).toMatchObject({ version: 1 })
    const out = await share(['--json', '-c', 'other', 'x.md'], { env: bot })
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 403 })

    const ls = JSON.parse((await share(['token', 'ls', '--service', '--json'], { env: admin })).stdout)
    expect(ls.map((x: { id: string }) => x.id)).toContain(t.id)
    await share(['token', 'revoke', t.id, '--service'], { env: admin })
    expect((await share(['whoami'], { env: bot })).code).toBe(1)
  })

  it('logs out: the token is revoked and removed from the config', async () => {
    const r = await share(['logout'])
    expect(r.stderr).toContain('token revoked')
    expect(readFileSync(join(HOME, '.config/shares/config'), 'utf8')).not.toMatch(/UPLOAD_TOKEN/)
    expect((await share(['whoami'])).stderr).toMatch(/not logged in/)
  })

  it.runIf(process.env.SHARE_DIST)('installs the binary with install.sh and logs in with it', async () => {
    const script = await (await fetch(`${LOCAL}/_install.sh`)).text()
    expect(script).toContain(`APP_URL="${LOCAL}"`)
    const bin = join(dir, 'bin')
    const r = spawnSync('sh', ['-c', script], {
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin`, HOME, SHARE_INSTALL_DIR: bin, SHARE_RELEASE_URL: `file://${process.env.SHARE_DIST}` },
      encoding: 'utf8',
    })
    expect(r.stderr).toContain(`next: share login ${LOCAL}`)
    expect(r.status).toBe(0)
    const v = spawnSync(join(bin, 'share'), ['--version'], { encoding: 'utf8' })
    expect(v.stdout).toMatch(/^share \d/)
  })
})
