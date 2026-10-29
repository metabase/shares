// Export every key of a Workers KV namespace (the mb-shares store) to a
// directory, through the Cloudflare REST API. Run it again into the same
// directory to resume an export: values already on disk are kept, so a new
// export (after more writes) goes into a new directory.
//
//   CLOUDFLARE_API_TOKEN=... bun scripts/migrate/export.ts \
//     --account <account id> --namespace <namespace id> --out <dir>
//
// The token needs "Workers KV Storage: Read" on the account. Output:
//   export.json   ExportInfo (plan.ts)
//   keys.jsonl    one ExportKey per key: name, metadata, value file
//   values/<sha256 of the key name>   the value bytes

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { pool, sleep } from '../../cli/http'
import type { ExportInfo, ExportKey } from './plan'

const PARALLEL = 8

export interface KvApi {
  base: string // https://api.cloudflare.com/client/v4
  account: string
  namespace: string
  token: string
}

async function call(api: KvApi, path: string) {
  const url = `${api.base}/accounts/${api.account}/storage/kv/namespaces/${api.namespace}${path}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${api.token}` } })
    if (res.ok) return res
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await res.body?.cancel()
      await sleep(1000 * 2 ** attempt)
      continue
    }
    throw new Error(`${res.status} ${await res.text()} (${path})`)
  }
}

interface ListResult {
  result: { name: string; metadata?: ExportKey['metadata'] }[]
  result_info?: { cursor?: string }
}

export async function exportKv(api: KvApi, out: string, log = (s: string) => console.error(s)) {
  mkdirSync(join(out, 'values'), { recursive: true })
  const keys: ExportKey[] = []
  let cursor = ''
  do {
    const r = await (await call(api, `/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json() as ListResult
    for (const k of r.result) {
      const file = `values/${createHash('sha256').update(k.name).digest('hex')}`
      keys.push({ name: k.name, ...(k.metadata ? { metadata: k.metadata } : {}), file })
    }
    cursor = r.result_info?.cursor ?? ''
  } while (cursor)
  log(`keys: ${keys.length}`)

  let done = 0
  await pool(keys, PARALLEL, async (k) => {
    const path = join(out, k.file)
    if (!existsSync(path)) {
      const body = new Uint8Array(await (await call(api, `/values/${encodeURIComponent(k.name)}`)).arrayBuffer())
      writeFileSync(`${path}.tmp`, body)
      renameSync(`${path}.tmp`, path)
    }
    if (++done % 500 === 0) log(`values: ${done}/${keys.length}`)
  })

  writeFileSync(join(out, 'keys.jsonl'), keys.map((k) => JSON.stringify(k)).join('\n') + '\n')
  const info: ExportInfo = { account: api.account, namespace: api.namespace, exportedAt: Date.now(), keys: keys.length }
  writeFileSync(join(out, 'export.json'), JSON.stringify(info, null, 2) + '\n')
  return info
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      namespace: { type: 'string' },
      out: { type: 'string' },
      api: { type: 'string', default: 'https://api.cloudflare.com/client/v4' },
    },
  })
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!values.account || !values.namespace || !values.out || !token) {
    console.error('usage: CLOUDFLARE_API_TOKEN=... bun scripts/migrate/export.ts --account ID --namespace ID --out DIR')
    process.exit(2)
  }
  const info = await exportKv({ base: values.api!, account: values.account, namespace: values.namespace, token }, values.out)
  console.log(`exported ${info.keys} keys to ${values.out}`)
}
