#!/usr/bin/env node
// Entry point of the `share` binary (bun build --compile).
import { main } from './main'

const chunks: Buffer[] = []
const code = await main(process.argv.slice(2), {
  stdout: (s) => { process.stdout.write(s) },
  stderr: (s) => { process.stderr.write(s) },
  stdin: async () => {
    for await (const c of process.stdin) chunks.push(c as Buffer)
    return new Uint8Array(Buffer.concat(chunks))
  },
  env: process.env,
  cwd: process.cwd(),
})
process.exitCode = code
