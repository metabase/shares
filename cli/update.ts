// Update notice and `share update`. The worker puts x-share-cli-latest (and
// optionally x-share-cli-min) on its CLI answers (src/cli-version.ts). The
// CLI never updates itself without `share update`.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const REPO = 'https://github.com/metabase/shares/releases'
const DAY_MS = 24 * 60 * 60 * 1000

type Env = Record<string, string | undefined>

// x.y.z with an optional -pre part. null: not a version.
function parse(v: string) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(v.trim())
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null
}

// -1, 0 or 1 as a < b, a = b, a > b; null when one is not a version.
// A prerelease comes before its release (0.3.0-rc.1 < 0.3.0).
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a), y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre < y.pre ? -1 : 1
}

export const isNewer = (latest: string, current: string) => compareVersions(latest, current) === 1

export const stateFile = (env: Env) => join(env.HOME || homedir(), '.config/shares/update-check')

export interface NoticeIo {
  stderr: (s: string) => void
  env: Env
  stderrIsTTY?: boolean
}

// One stderr line when the server names a newer release, at most once a day
// (state: ~/.config/shares/update-check). Never on stdout. Off for a dev
// build, with SHARE_NO_UPDATE_CHECK=1, under CI, and when stderr is not a
// terminal. Returns true when it printed.
export function updateNotice(latest: string | null, current: string, io: NoticeIo, now = Date.now()): boolean {
  const { env } = io
  if (!latest || current === 'dev' || !io.stderrIsTTY) return false
  if (env.SHARE_NO_UPDATE_CHECK === '1' || env.CI) return false
  if (!isNewer(latest, current)) return false
  const path = stateFile(env)
  try {
    const last = Number(readFileSync(path, 'utf8').trim())
    if (Number.isFinite(last) && now - last < DAY_MS && now >= last) return false
  } catch { /* no state yet */ }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${now}\n`)
  } catch { /* read-only home: show the notice anyway */ }
  io.stderr(`share ${latest} is out (you have ${current}): share update\n`)
  return true
}

// The message when the server needs a newer CLI; null when this one is ok.
export function tooOld(min: string | null, current: string): string | null {
  if (!min || current === 'dev') return null
  return compareVersions(current, min) === -1 ? `share ${current} is too old for this server: run share update` : null
}

// The release binary name for this machine, as cli/install.sh picks it:
// SHARE_OS / SHARE_ARCH override; an x64 process under Rosetta takes the
// arm64 binary; no musl (Alpine) binary.
export function binaryName(env: Env, platform: string = process.platform, arch: string = process.arch,
  rosetta: () => boolean = isRosetta, alpine: () => boolean = () => existsSync('/etc/alpine-release')): string {
  const o = (env.SHARE_OS || platform).toLowerCase()
  const os = o === 'darwin' ? 'darwin' : o === 'linux' ? 'linux' : null
  if (!os) throw new Error(`no binary for OS ${o} (macOS and Linux only; on Windows, use WSL)`)
  const a = env.SHARE_ARCH || arch
  let cpu = a === 'arm64' || a === 'aarch64' ? 'arm64' : a === 'x64' || a === 'x86_64' || a === 'amd64' ? 'x64' : null
  if (!cpu) throw new Error(`no binary for CPU ${a}`)
  if (!env.SHARE_ARCH && os === 'darwin' && cpu === 'x64' && rosetta()) cpu = 'arm64'
  if (os === 'linux' && alpine()) throw new Error('no musl (Alpine) binary; use a glibc distribution')
  return `share-${os}-${cpu}`
}

function isRosetta() {
  try {
    return execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1'
  } catch { return false }
}

// the sha256 of `name` in a SHA256SUMS file ("<hex>  <name>" or "<hex> *<name>")
export function expectedSum(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const [hex, file] = line.trim().split(/\s+/)
    if (hex && (file === name || file === `*${name}`)) return hex.toLowerCase()
  }
  return null
}

// "0.3.0" and "cli-v0.3.0" both name tag cli-v0.3.0
export function tagOf(version: string) {
  const v = version.replace(/^cli-v/, '').replace(/^v/, '')
  if (!parse(v)) throw new Error(`not a version: ${version} (e.g. 0.3.0)`)
  return { version: v, tag: `cli-v${v}` }
}

// the directory that holds the release files
export function releaseBase(env: Env, version?: string) {
  if (env.SHARE_RELEASE_URL) return env.SHARE_RELEASE_URL.replace(/\/+$/, '')
  return version ? `${REPO}/download/${tagOf(version).tag}` : `${REPO}/latest/download`
}

// the newest stable release, from the GitHub latest-release redirect
export async function latestRelease(): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${REPO}/latest`, { redirect: 'manual', headers: { 'user-agent': 'share-cli' } })
  } catch (e) {
    throw new Error(`cannot reach ${REPO}/latest: ${(e as Error).message}`)
  }
  await res.body?.cancel()
  const m = /\/tag\/cli-v([^/?#]+)$/.exec(res.headers.get('location') || '')
  if (!m || !parse(m[1])) throw new Error(`cannot tell the latest release from ${REPO}/latest (${res.status})`)
  return m[1]
}

async function download(url: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': 'share-cli' } })
  } catch (e) {
    throw new Error(`download failed: ${url}: ${(e as Error).message}`)
  }
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

// The release binary for this machine, checked against SHA256SUMS.
export async function fetchBinary(base: string, name: string): Promise<Uint8Array> {
  const [bin, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/SHA256SUMS`)])
  const want = expectedSum(new TextDecoder().decode(sums), name)
  if (!want) throw new Error(`${name} is not in ${base}/SHA256SUMS`)
  const got = createHash('sha256').update(bin).digest('hex')
  if (got !== want) throw new Error(`checksum mismatch for ${name} (got ${got}, want ${want}); nothing was changed`)
  return bin
}

export class NotWritable extends Error {
  constructor(readonly dir: string) { super(`cannot write to ${dir}`) }
}

// the real path of the binary; NotWritable when its directory is not writable
export function writableTarget(target: string): string {
  const path = realpathSync(target)
  try { accessSync(dirname(path), constants.W_OK) } catch { throw new NotWritable(dirname(path)) }
  return path
}

// Put `bin` in place of `target`: a temp file in the same directory, mode
// 755, a run of `<temp> --version`, then a rename over the target (atomic;
// a running process keeps its old file). Returns the new version.
export function replaceBinary(target: string, bin: Uint8Array): string {
  const path = writableTarget(target)
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.update-${process.pid}`)
  try {
    try { writeFileSync(tmp, bin, { mode: 0o755 }) } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new NotWritable(dir)
      throw e
    }
    chmodSync(tmp, 0o755)
    let out: string
    try {
      out = execFileSync(tmp, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      throw new Error(`the new binary does not run here (${(e as Error).message.split('\n')[0]}); nothing was changed`)
    }
    const m = /share (\S+)/.exec(out)
    if (!m) throw new Error(`the new binary printed no version (${out.trim()}); nothing was changed`)
    renameSync(tmp, path)
    return m[1]
  } finally {
    rmSync(tmp, { force: true })
  }
}

// the command for a directory this user cannot write to
export function installCommand(appUrl: string, dir: string, tag?: string) {
  const vars = [`SHARE_INSTALL_DIR=${dir}`, ...(tag ? [`SHARE_VERSION=${tag}`] : [])].join(' ')
  return `curl -fsSL ${appUrl}/install.sh | sudo env ${vars} sh`
}
