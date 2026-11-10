import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Io, main, parseArgs, VERSION } from '../main'
import {
  binaryName, compareVersions, expectedSum, installCommand, releaseBase, stateFile, tooOld, updateNotice,
} from '../update'

const tmp = () => mkdtempSync(join(tmpdir(), 'share-update-'))
const DAY = 24 * 60 * 60 * 1000

describe('compareVersions', () => {
  it('orders versions by number, a prerelease before its release', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0)
    expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBe(-1)
    expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBe(1)
    expect(compareVersions('0.3.0-rc.1', '0.3.0-rc.2')).toBe(-1)
  })

  it('gives null for a value that is not a version', () => {
    expect(compareVersions('dev', '0.2.0')).toBeNull()
    expect(compareVersions('0.2', '0.2.0')).toBeNull()
  })
})

describe('updateNotice', () => {
  const io = (env: Record<string, string> = {}, tty = true) => {
    const out = { stderr: '', home: tmp() }
    return { out, io: { stderr: (s: string) => { out.stderr += s }, env: { HOME: out.home, ...env }, stderrIsTTY: tty } }
  }

  it('prints one stderr line for a newer release, then not again for a day', () => {
    const { out, io: i } = io()
    const now = Date.now()
    expect(updateNotice('0.3.0', '0.2.0', i, now)).toBe(true)
    expect(out.stderr).toBe('share 0.3.0 is out (you have 0.2.0): share update\n')
    expect(readFileSync(stateFile(i.env), 'utf8').trim()).toBe(String(now))
    expect(updateNotice('0.3.0', '0.2.0', i, now + DAY - 1)).toBe(false)
    expect(updateNotice('0.3.0', '0.2.0', i, now + DAY)).toBe(true)
    expect(out.stderr.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('prints nothing for the same or an older release, or no header', () => {
    const { out, io: i } = io()
    expect(updateNotice('0.2.0', '0.2.0', i)).toBe(false)
    expect(updateNotice('0.1.9', '0.2.0', i)).toBe(false)
    expect(updateNotice(null, '0.2.0', i)).toBe(false)
    expect(out.stderr).toBe('')
  })

  it('is off for a dev build, SHARE_NO_UPDATE_CHECK=1, CI and a non-terminal stderr', () => {
    for (const [i, version] of [
      [io().io, 'dev'], [io({ SHARE_NO_UPDATE_CHECK: '1' }).io, '0.2.0'], [io({ CI: 'true' }).io, '0.2.0'], [io({}, false).io, '0.2.0'],
    ] as const) {
      expect(updateNotice('0.3.0', version, i)).toBe(false)
      expect(existsSync(stateFile(i.env))).toBe(false)
    }
  })
})

describe('tooOld', () => {
  it('stops a CLI below the minimum only', () => {
    expect(tooOld('0.3.0', '0.2.0')).toBe('share 0.2.0 is too old for this server: run share update')
    expect(tooOld('0.3.0', '0.3.0')).toBeNull()
    expect(tooOld(null, '0.2.0')).toBeNull()
    expect(tooOld('0.3.0', 'dev')).toBeNull()
  })
})

describe('release files', () => {
  it('picks the binary name as install.sh does', () => {
    const no = () => false
    expect(binaryName({}, 'darwin', 'arm64', no, no)).toBe('share-darwin-arm64')
    expect(binaryName({}, 'darwin', 'x64', () => true, no)).toBe('share-darwin-arm64')
    expect(binaryName({ SHARE_ARCH: 'x86_64' }, 'darwin', 'arm64', () => true, no)).toBe('share-darwin-x64')
    expect(binaryName({}, 'linux', 'x64', no, no)).toBe('share-linux-x64')
    expect(binaryName({ SHARE_OS: 'Linux', SHARE_ARCH: 'aarch64' }, 'darwin', 'x64', no, no)).toBe('share-linux-arm64')
    expect(() => binaryName({}, 'linux', 'x64', no, () => true)).toThrow(/Alpine/)
    expect(() => binaryName({}, 'win32', 'x64', no, no)).toThrow(/no binary for OS win32/)
    expect(() => binaryName({}, 'linux', 'ia32', no, no)).toThrow(/no binary for CPU ia32/)
  })

  it('reads SHA256SUMS lines with and without the binary marker', () => {
    const sums = 'AAA  share-darwin-arm64\nbbb *share-linux-x64\n'
    expect(expectedSum(sums, 'share-darwin-arm64')).toBe('aaa')
    expect(expectedSum(sums, 'share-linux-x64')).toBe('bbb')
    expect(expectedSum(sums, 'share-linux-arm64')).toBeNull()
  })

  it('takes the release directory from SHARE_RELEASE_URL, a version or latest', () => {
    expect(releaseBase({ SHARE_RELEASE_URL: 'http://x/rel/' })).toBe('http://x/rel')
    expect(releaseBase({}, '0.3.0')).toBe('https://github.com/metabase/shares/releases/download/cli-v0.3.0')
    expect(releaseBase({}, 'cli-v0.3.0')).toBe('https://github.com/metabase/shares/releases/download/cli-v0.3.0')
    expect(releaseBase({})).toBe('https://github.com/metabase/shares/releases/latest/download')
    expect(installCommand('https://app.test', '/usr/local/bin', 'cli-v0.3.0'))
      .toBe('curl -fsSL https://app.test/install.sh | sudo env SHARE_INSTALL_DIR=/usr/local/bin SHARE_VERSION=cli-v0.3.0 sh')
  })

  it('reads --version after update as the release to install, elsewhere as the version command', () => {
    expect(parseArgs(['update', '--version', '0.3.0', '--check'])).toMatchObject({ args: ['update'], opts: { updateVersion: '0.3.0', check: true } })
    expect(parseArgs(['--version']).args).toEqual(['version'])
  })
})

// A fake server: the API answers with version headers, /rel/ is a release
// directory with one binary (a shell script) and SHA256SUMS.
describe('share against version headers and a release directory', () => {
  let server: Server
  let base = ''
  const headers: Record<string, string> = {}
  const rel: Record<string, Buffer> = {}
  const name = binaryName({})
  const requests: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      if (req.url?.startsWith('/rel/')) {
        const f = rel[req.url.slice(5)]
        res.writeHead(f ? 200 : 404).end(f ?? 'not found')
        return
      }
      res.writeHead(200, headers).end(req.url === '/_list' ? 'a-1\n' : '')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server.close() })
  afterEach(() => {
    for (const k of Object.keys(headers)) delete headers[k]
    requests.length = 0
  })

  function release(script: string, sum?: string) {
    rel[name] = Buffer.from(script)
    rel.SHA256SUMS = Buffer.from(`${sum ?? createHash('sha256').update(rel[name]).digest('hex')}  ${name}\n`)
  }

  async function run(argv: string[], opts: { env?: Record<string, string>; tty?: boolean; execPath?: string; home?: string } = {}) {
    const home = opts.home ?? tmp()
    let stdout = ''
    let stderr = ''
    const io: Io = {
      stdout: (s) => { stdout += typeof s === 'string' ? s : new TextDecoder().decode(s) },
      stderr: (s) => { stderr += s },
      stdin: async () => new Uint8Array(),
      env: { HOME: home, SHARES_URL: base, SHARES_TOKEN: 't', SHARE_RELEASE_URL: `${base}/rel`, ...opts.env },
      cwd: home,
      stderrIsTTY: opts.tty ?? true,
      execPath: opts.execPath,
    }
    const code = await main(argv, io)
    return { code, stdout, stderr, home }
  }

  it('runs as the release version the config defines', () => {
    expect(VERSION).toBe('0.2.0')
  })

  it('shows the update notice on stderr once a day, never on stdout', async () => {
    headers['x-share-cli-latest'] = '0.3.0'
    const a = await run(['--json'])
    expect(a.code).toBe(0)
    expect(a.stdout).toBe('["a-1"]\n')
    expect(a.stderr).toBe('share 0.3.0 is out (you have 0.2.0): share update\n')
    const b = await run(['--json'], { home: a.home })
    expect(b.stderr).toBe('')
    const c = await run([], { tty: false })
    expect(c.stderr).toBe('')
  })

  it('stops a CLI below x-share-cli-min, except for update, version, help, login and logout', async () => {
    headers['x-share-cli-min'] = '0.3.0'
    const r = await run(['--json'])
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('share: share 0.2.0 is too old for this server: run share update\n')
    expect(JSON.parse(r.stdout)).toEqual({ error: 'share 0.2.0 is too old for this server: run share update' })
    expect((await run(['--version'])).code).toBe(0)
    expect((await run(['logout'], { env: { SHARE_CONF: join(tmp(), 'config') } })).code).toBe(0)
  })

  function installed() {
    const dir = tmp()
    const path = join(dir, 'share')
    writeFileSync(path, '#!/bin/sh\necho "share 0.2.0"\n')
    chmodSync(path, 0o755)
    return { dir, path }
  }

  it('replaces the binary with the release one after a checksum and run check', async () => {
    release('#!/bin/sh\necho "share 9.9.9"\n')
    const { dir, path } = installed()
    const r = await run(['update', '--json'], { execPath: path })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ current: '0.2.0', latest: '9.9.9', updated: true, path })
    expect(readFileSync(path, 'utf8')).toContain('share 9.9.9')
    expect(statSync(path).mode & 0o777).toBe(0o755)
    expect(readdirSync(dir)).toEqual(['share'])
    expect(requests).toEqual([`GET /rel/${name}`, 'GET /rel/SHA256SUMS'])
  })

  it('refuses a checksum mismatch and leaves the binary as it was', async () => {
    release('#!/bin/sh\necho "share 9.9.9"\n', 'ab'.repeat(32))
    const { dir, path } = installed()
    const r = await run(['update'], { execPath: path })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/checksum mismatch for share-.*nothing was changed/)
    expect(readFileSync(path, 'utf8')).toContain('share 0.2.0')
    expect(readdirSync(dir)).toEqual(['share'])
  })

  it('refuses a binary that does not run and leaves the old one', async () => {
    release('#!/bin/sh\nexit 3\n')
    const { dir, path } = installed()
    const r = await run(['update'], { execPath: path })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/does not run here/)
    expect(readFileSync(path, 'utf8')).toContain('share 0.2.0')
    expect(readdirSync(dir)).toEqual(['share'])
  })

  it('prints the install command for a directory it cannot write', async () => {
    if (process.getuid?.() === 0) return
    release('#!/bin/sh\necho "share 9.9.9"\n')
    const { dir: link, path } = installed()
    const dir = realpathSync(link)
    chmodSync(dir, 0o555)
    try {
      const r = await run(['update', '--version', '0.4.0'], { execPath: path })
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(`cannot write to ${dir}`)
      expect(requests).toEqual([])
      expect(r.stderr).toContain(`install.sh | sudo env SHARE_INSTALL_DIR=${dir} SHARE_VERSION=cli-v0.4.0 sh`)
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('reports with --check and changes nothing', async () => {
    const { path } = installed()
    const r = await run(['update', '--check', '--version', '0.3.0'], { execPath: path })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('share 0.3.0 is out (you have 0.2.0): share update\n')
    const same = await run(['update', '--check', '--version', '0.2.0', '--json'], { execPath: path })
    expect(JSON.parse(same.stdout)).toEqual({ current: '0.2.0', latest: '0.2.0', update: false })
    expect(requests).toEqual([])
  })

  it('asks GitHub for the latest release without SHARE_RELEASE_URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://github.com/metabase/shares/releases/tag/cli-v0.2.0' },
    }))
    try {
      const r = await run(['update', '--json'], { env: { SHARE_RELEASE_URL: '' }, execPath: installed().path })
      expect(JSON.parse(r.stdout)).toMatchObject({ current: '0.2.0', latest: '0.2.0', updated: false })
      expect(spy).toHaveBeenCalledWith('https://github.com/metabase/shares/releases/latest', expect.objectContaining({ redirect: 'manual' }))
    } finally {
      spy.mockRestore()
    }
  })
})
