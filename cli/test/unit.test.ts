import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, parseConfig, updateConfig } from '../config'
import { collect, defaultName, deslug, localCopy, mirror } from '../files'
import { loginBase, parseArgs } from '../main'

const tmp = () => mkdtempSync(join(tmpdir(), 'share-unit-'))

describe('parseArgs', () => {
  it('reads publish flags anywhere and keeps positionals in order', () => {
    const { opts, args } = parseArgs(['-e', 'dir', '--json', 'slug-a3f2b', '-m', 'pr=1', '-m', 'k=a=b', '-c', 'x/y'])
    expect(args).toEqual(['dir', 'slug-a3f2b'])
    expect(opts).toMatchObject({ edit: true, json: true, collection: 'x/y', meta: { pr: '1', k: 'a=b' } })
  })

  it('maps --local, -h and -V to commands', () => {
    expect(parseArgs(['--local', 'x']).args).toEqual(['local', 'x'])
    expect(parseArgs(['-h']).args).toEqual(['help'])
    expect(parseArgs(['-V']).args).toEqual(['version'])
  })

  it('takes everything after -- as positionals', () => {
    expect(parseArgs(['--', '-x', '--json']).args).toEqual(['-x', '--json'])
  })

  it('refuses unknown options and bad meta', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/)
    expect(() => parseArgs(['-m', 'novalue'])).toThrow(/key=value/)
    expect(() => parseArgs(['-f'])).toThrow(/needs a value/)
  })

  it('collects repeated scopes for token create', () => {
    const { opts } = parseArgs(['token', 'create', 'bot', '--scope', 'write:a/*', '--scope', 'read:b', '--days', '30'])
    expect(opts.scopes).toEqual(['write:a/*', 'read:b'])
    expect(opts.days).toBe(30)
  })
})

describe('deslug', () => {
  it('strips scheme, host, query and the trailing slash', () => {
    expect(deslug('https://shares.metabase.fyi/report-a3f2b/')).toBe('report-a3f2b')
    expect(deslug('https://shares.metabase.fyi/report-a3f2b/sub/a%20b.md?x=1')).toBe('report-a3f2b/sub/a b.md')
    expect(deslug('report-a3f2b')).toBe('report-a3f2b')
  })
})

describe('collect', () => {
  it('publishes a single .md or .html file as the index', () => {
    const d = tmp()
    writeFileSync(join(d, 'x.md'), '# x')
    writeFileSync(join(d, 'y.html'), '<p>')
    writeFileSync(join(d, 'z.csv'), 'a')
    expect(collect([join(d, 'x.md')]).map((f) => f.path)).toEqual(['index.md'])
    expect(collect([join(d, 'y.html')]).map((f) => f.path)).toEqual(['index.html'])
    expect(collect([join(d, 'z.csv')]).map((f) => f.path)).toEqual(['z.csv'])
  })

  it('walks a dir with symlinks followed and .git skipped', () => {
    const d = tmp()
    mkdirSync(join(d, 'a/.git'), { recursive: true })
    mkdirSync(join(d, 'other'))
    writeFileSync(join(d, 'a/one.txt'), '1')
    writeFileSync(join(d, 'a/.git/HEAD'), 'x')
    writeFileSync(join(d, 'other/two.txt'), '2')
    symlinkSync(join(d, 'other'), join(d, 'a/link'))
    expect(collect([join(d, 'a')]).map((f) => f.path)).toEqual(['link/two.txt', 'one.txt'])
  })

  it('puts files at the top and dirs under their name in the glob form', () => {
    const d = tmp()
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'a.md'), 'a')
    writeFileSync(join(d, 'sub/b.txt'), 'b')
    expect(collect([join(d, 'a.md'), join(d, 'sub')]).map((f) => f.path)).toEqual(['a.md', 'sub/b.txt'])
  })

  it('refuses a missing path', () => {
    expect(() => collect(['/no/such/path'])).toThrow(/no such path/)
  })
})

describe('defaultName', () => {
  it('drops the extension of a file and turns spaces into dashes', () => {
    const d = tmp()
    writeFileSync(join(d, 'my report.md'), '')
    expect(defaultName(join(d, 'my report.md'))).toBe('my-report')
    expect(defaultName(d)).toMatch(/^share-unit-/)
  })
})

describe('config', () => {
  it('parses shell assignments with quotes and export', () => {
    expect(parseConfig('export BASE_URL="https://a"\nUPLOAD_TOKEN=\'t\'\n# c\nCONTENT_URL=https://c\n'))
      .toEqual({ BASE_URL: 'https://a', UPLOAD_TOKEN: 't', CONTENT_URL: 'https://c' })
  })

  it('reads the old mb-shares env file when the new one is missing', () => {
    const home = tmp()
    mkdirSync(join(home, '.config/mb-shares'), { recursive: true })
    writeFileSync(join(home, '.config/mb-shares/env'), 'BASE_URL=https://old/\nUPLOAD_TOKEN=t\n')
    const c = loadConfig({ HOME: home })
    expect(c).toMatchObject({ baseUrl: 'https://old', token: 't', path: join(home, '.config/mb-shares/env'), legacy: true })
  })

  it('logs in at the default app, not the BASE_URL of the old mb-shares env file', () => {
    const home = tmp()
    mkdirSync(join(home, '.config/mb-shares'), { recursive: true })
    writeFileSync(join(home, '.config/mb-shares/env'), 'BASE_URL=https://old/\nUPLOAD_TOKEN=t\n')
    const env = { HOME: home }
    expect(loginBase(undefined, env, loadConfig(env))).toBe('https://app.shares.metabase.fyi')
    expect(loginBase('https://arg/', env, loadConfig(env))).toBe('https://arg')
  })

  it('logs in at the BASE_URL of the new config file', () => {
    const home = tmp()
    mkdirSync(join(home, '.config/shares'), { recursive: true })
    writeFileSync(join(home, '.config/shares/config'), 'BASE_URL=https://mine/\n')
    const env = { HOME: home }
    expect(loadConfig(env).legacy).toBe(false)
    expect(loginBase(undefined, env, loadConfig(env))).toBe('https://mine')
  })

  it('lets SHARES_TOKEN and SHARES_URL win over the file', () => {
    const home = tmp()
    const conf = join(home, 'c')
    writeFileSync(conf, 'BASE_URL=https://file\nUPLOAD_TOKEN=file\n')
    expect(loadConfig({ HOME: home, SHARE_CONF: conf, SHARES_TOKEN: 'env', SHARES_URL: 'https://env' }))
      .toMatchObject({ baseUrl: 'https://env', token: 'env' })
  })

  it('updates keys in place, keeps other lines and writes mode 0600', () => {
    const p = join(tmp(), 'sub/config')
    updateConfig(p, { BASE_URL: 'https://a', UPLOAD_TOKEN: 't' })
    writeFileSync(p, readFileSync(p, 'utf8') + 'MIRROR_DIR=/m\n')
    updateConfig(p, { UPLOAD_TOKEN: undefined })
    expect(readFileSync(p, 'utf8')).toBe('BASE_URL=https://a\nMIRROR_DIR=/m\n')
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
})

describe('mirror and --local', () => {
  it('finds the source path, then the mirror copy', () => {
    const m = tmp()
    const src = tmp()
    writeFileSync(join(src, 'a.txt'), 'a')
    const files = collect([src])
    mirror(m, 's-1', files, src, false)
    expect(readFileSync(join(m, 's-1/a.txt'), 'utf8')).toBe('a')
    expect(localCopy(m, 's-1/a.txt')).toBe(join(src, 'a.txt'))
    mirror(m, 's-2', files, '/gone', false)
    expect(localCopy(m, 's-2/a.txt')).toBe(join(m, 's-2/a.txt'))
    expect(localCopy(m, 'nope')).toBeNull()
  })
})
