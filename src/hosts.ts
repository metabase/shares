// One Worker, two hosts (decision two-hosts-on-metabase-fyi): the content
// host serves share files only, the app host serves the API, login, tokens
// and UI. Until SHR-5 splits the routes, both entry points serve everything,
// the same as a host that matches neither (workers.dev, wrangler dev).

import type { Env } from './env'
import { handle } from './routes'

export type HostKind = 'content' | 'app' | 'combined'
export type Entry = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

export function hostKind(url: URL, env: Env): HostKind {
  if (env.CONTENT_HOST && url.hostname === env.CONTENT_HOST) return 'content'
  if (env.APP_HOST && url.hostname === env.APP_HOST) return 'app'
  return 'combined'
}

export const contentHost: Entry = handle
export const appHost: Entry = handle

export function entryFor(url: URL, env: Env): Entry {
  const kind = hostKind(url, env)
  return kind === 'content' ? contentHost : kind === 'app' ? appHost : handle
}
