// Return local dev to a known state: wipe the local D1, R2 and KV state,
// apply the D1 migrations, and seed it (scripts/dev-seed.ts).
//
//   bun run dev:reset
//
// Stop `bun run dev` first: a running worker keeps its open handles to the
// deleted files and serves the old data (finding wrangler-state-deleted-under-dev),
// so the reset refuses while a process holds files in .wrangler/state.
// The seed needs a worker: the reset starts its own `wrangler dev` on a free
// port with the same state, seeds it, and stops it.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'

const STATE = '.wrangler/state'

function fail(msg: string): never {
  console.error(`dev-reset: ${msg}`)
  process.exit(1)
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}`)
}

// processes with files open under .wrangler/state, as "pid command"
function holders(): string[] {
  if (!existsSync(STATE)) return []
  const r = spawnSync('lsof', ['-F', 'pc', '+D', STATE], { encoding: 'utf8' })
  if (r.error) fail(`lsof: ${r.error.message} (needed to see whether bun run dev holds ${STATE})`)
  const out = new Map<string, string>()
  let pid = ''
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = line.slice(1)
    else if (line[0] === 'c' && pid) out.set(pid, line.slice(1))
  }
  return [...out].map(([p, c]) => `${p} ${c}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function ready(url: string, dev: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (dev.exitCode !== null) return false
    try {
      await (await fetch(url, { redirect: 'manual' })).body?.cancel()
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return false
}

function stop(dev: ChildProcess) {
  if (dev.exitCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    dev.once('exit', () => resolve())
    process.kill(-dev.pid!, 'SIGTERM')
  })
}

if (!existsSync('.dev.vars')) fail('.dev.vars missing: cp .dev.vars.example .dev.vars (the seed needs SESSION_SECRET and UPLOAD_TOKEN)')
const held = holders()
if (held.length) fail(`stop bun run dev first; these processes hold files in ${STATE}:\n  ${held.join('\n  ')}`)

rmSync(STATE, { recursive: true, force: true })
console.log(`removed ${STATE}`)
run('bunx', ['wrangler', 'd1', 'migrations', 'apply', 'shares', '--local'])

const port = await freePort()
const url = `http://127.0.0.1:${port}`
const log: string[] = []
const dev = spawn('bunx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port)], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const s of [dev.stdout!, dev.stderr!]) s.on('data', (d) => log.push(String(d)))
const up = await ready(url, dev)
const code = up ? spawnSync('bun', ['scripts/dev-seed.ts', '--url', url], { stdio: 'inherit' }).status : 1
await stop(dev)
if (!up) {
  console.error(log.join(''))
  fail(`wrangler dev on ${url} did not start`)
}
if (code !== 0) fail('dev:seed failed')
console.log('local state is reset and seeded: bun run dev, then open http://localhost:8787/_dev/login')
