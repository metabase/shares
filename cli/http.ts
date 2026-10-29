// HTTP client of the worker API (src/api-types.ts). Retries network errors,
// 429 and 5xx twice, like `curl --retry 2` in the bash CLI.

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly url: string) {
    super(`${status} ${body.trim() || 'error'} (${url})`)
  }
}

export class UsageError extends Error {}

export interface Client {
  base: string
  request(method: string, path: string, init?: { body?: BodyInit; json?: unknown; headers?: Record<string, string>; auth?: boolean }): Promise<Response>
  text(method: string, path: string, init?: Parameters<Client['request']>[2]): Promise<string>
  json<T>(method: string, path: string, init?: Parameters<Client['request']>[2]): Promise<T>
}

const RETRIES = 2

export function client(base: string, token?: string): Client {
  const c: Client = {
    base,
    async request(method, path, init = {}) {
      const headers: Record<string, string> = { 'user-agent': 'share-cli', ...init.headers }
      if (init.auth !== false && token) headers.authorization = `Bearer ${token}`
      let body = init.body
      if (init.json !== undefined) {
        body = JSON.stringify(init.json)
        headers['content-type'] = 'application/json'
      }
      const url = `${base}${path}`
      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await fetch(url, { method, headers, body })
        } catch (e) {
          if (attempt < RETRIES) { await sleep(500 * (attempt + 1)); continue }
          throw new Error(`cannot reach ${url}: ${(e as Error).message}`)
        }
        if ((res.status === 429 || res.status >= 500) && res.status !== 501 && attempt < RETRIES) {
          await res.body?.cancel()
          await sleep(500 * (attempt + 1))
          continue
        }
        return res
      }
    },
    async text(method, path, init) {
      const res = await c.request(method, path, init)
      const text = await res.text()
      if (!res.ok) throw new HttpError(res.status, errorText(text), `${method} ${path}`)
      return text
    },
    async json(method, path, init) {
      return JSON.parse(await c.text(method, path, init))
    },
  }
  return c
}

// JSON errors are {"error": "..."}; text errors are the body
function errorText(body: string) {
  try {
    const e = JSON.parse(body)
    if (e && typeof e.error === 'string') return e.error
  } catch { /* text body */ }
  return body
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// run fn over items, at most n at a time
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}
