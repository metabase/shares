// Which host a request is for, and the origins of the two hosts (decision
// two-hosts-on-metabase-fyi). No imports from routes: renderers use it too.

import type { Env } from './env'

export type HostKind = 'content' | 'app' | 'combined'

// CONTENT_HOST / APP_HOST are a URL host (hostname, optional :port). A
// request host that matches neither (workers.dev, wrangler dev, tests)
// gets one origin that serves everything.
export function hostKind(url: URL, env: Env): HostKind {
  if (env.CONTENT_HOST && url.host === env.CONTENT_HOST) return 'content'
  if (env.APP_HOST && url.host === env.APP_HOST) return 'app'
  return 'combined'
}

// Origins for links between the hosts. On the combined host both are '',
// so links stay relative.
export function contentBase(url: URL, env: Env) {
  return hostKind(url, env) === 'combined' ? '' : `${url.protocol}//${env.CONTENT_HOST}`
}

export function appBase(url: URL, env: Env) {
  return hostKind(url, env) === 'combined' ? '' : `${url.protocol}//${env.APP_HOST}`
}
