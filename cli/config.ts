// The CLI config file: shell-style KEY=VALUE lines (the bash CLI sources the
// same file). `share login` writes BASE_URL (the API), CONTENT_URL (share
// links) and UPLOAD_TOKEN. The old mb-shares path is still read.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_APP = 'https://app.shares.metabase.fyi'
export const CONFIG_KEYS = ['BASE_URL', 'CONTENT_URL', 'UPLOAD_TOKEN'] as const

export interface Config {
  path: string
  // path is the old mb-shares env file: its BASE_URL is the old worker
  legacy: boolean
  baseUrl?: string
  contentUrl?: string
  token?: string
  mirrorDir: string
}

type Env = Record<string, string | undefined>

export function configPath(env: Env = process.env): string {
  if (env.SHARE_CONF) return env.SHARE_CONF
  const home = env.HOME || homedir()
  const path = join(home, '.config/shares/config')
  const old = join(home, '.config/mb-shares/env')
  return !existsSync(path) && existsSync(old) ? old : path
}

export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

// The file wins over the environment, as when bash sources it. SHARES_URL,
// SHARES_CONTENT_URL and SHARES_TOKEN win over the file (CI, agents).
export function loadConfig(env: Env = process.env): Config {
  const path = configPath(env)
  const file = existsSync(path) ? parseConfig(readFileSync(path, 'utf8')) : {}
  const home = env.HOME || homedir()
  const trim = (u?: string) => u?.replace(/\/+$/, '') || undefined
  return {
    path,
    legacy: path === join(home, '.config/mb-shares/env'),
    baseUrl: trim(env.SHARES_URL || file.BASE_URL || env.BASE_URL),
    contentUrl: trim(env.SHARES_CONTENT_URL || file.CONTENT_URL || env.CONTENT_URL),
    token: env.SHARES_TOKEN || file.UPLOAD_TOKEN || env.UPLOAD_TOKEN || undefined,
    mirrorDir: file.MIRROR_DIR || env.MIRROR_DIR || join(home, '.local/share/mb-shares'),
  }
}

// Set or remove (undefined) keys; other lines of the file stay. Mode 0600.
export function updateConfig(path: string, values: Partial<Record<(typeof CONFIG_KEYS)[number], string | undefined>>) {
  const keys = Object.keys(values)
  const kept = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((l) => l && !keys.some((k) => new RegExp(`^\\s*(export\\s+)?${k}=`).test(l)))
    : []
  for (const [k, v] of Object.entries(values)) if (v !== undefined) kept.push(`${k}=${v}`)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
