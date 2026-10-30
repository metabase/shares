// One Worker, two hosts: the content
// host serves share files only, the app host serves the API, login, tokens
// and UI. A host that matches neither (workers.dev, wrangler dev) gets one
// origin that serves everything.

import type { Env } from './env'
import { hostKind } from './origins'
import { appHost, contentHost, handle } from './routes'

export { hostKind, type HostKind } from './origins'
export { appHost, contentHost } from './routes'

export type Entry = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

export function entryFor(url: URL, env: Env): Entry {
  const kind = hostKind(url, env)
  return kind === 'content' ? contentHost : kind === 'app' ? appHost : handle
}
