// Release build of the `share` CLI: bun cli/build.ts <version> [target...]
//
// dist/share-<os>-<arch>: standalone binaries (bun build --compile), the
// files that install.sh downloads; dist/SHA256SUMS; dist/npm: the
// @metabase/shares package (one Node 20+ script). Targets default to all;
// the target `npm` alone builds only dist/npm.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TARGETS: Record<string, string> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
}

const [version, ...only] = process.argv.slice(2)
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: bun cli/build.ts <version, e.g. 0.1.0> [target...]')
  process.exit(2)
}
const npmOnly = only.length === 1 && only[0] === 'npm'
for (const t of npmOnly ? [] : only) if (!TARGETS[t]) throw new Error(`unknown target ${t}; one of ${Object.keys(TARGETS).join(', ')}`)

const root = join(import.meta.dirname, '..')
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, 'npm'), { recursive: true })
const define = ['--define', `SHARE_VERSION=${JSON.stringify(version)}`]
const bun = (args: string[]) => execFileSync(process.execPath, ['build', ...args], { cwd: root, stdio: 'inherit' })

const sums: string[] = []
for (const name of npmOnly ? [] : only.length ? only : Object.keys(TARGETS)) {
  const out = join(dist, `share-${name}`)
  bun(['cli/share.ts', '--compile', `--target=${TARGETS[name]}`, '--minify', ...define, '--outfile', out])
  sums.push(`${createHash('sha256').update(readFileSync(out)).digest('hex')}  share-${name}`)
}
if (sums.length) writeFileSync(join(dist, 'SHA256SUMS'), sums.join('\n') + '\n')

bun(['cli/share.ts', '--target=node', '--format=esm', ...define, '--outfile', join(dist, 'npm/share.js')])
chmodSync(join(dist, 'npm/share.js'), 0o755)
const pkg = JSON.parse(readFileSync(join(root, 'cli/npm/package.json'), 'utf8'))
writeFileSync(join(dist, 'npm/package.json'), JSON.stringify({ ...pkg, version }, null, 2) + '\n')
copyFileSync(join(root, 'cli/npm/README.md'), join(dist, 'npm/README.md'))
