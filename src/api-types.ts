// HTTP API of the Worker, for clients (the TS CLI, SHR-7). No imports: the
// CLI imports this file without the Worker's runtime types.
//
// Every endpoint but /_cli, /_skill and /_device* takes
// `Authorization: Bearer <token>`. A missing, bad, expired or revoked token
// gives 401 "unauthorized". Bodies are text unless noted. Errors are
// text with a trailing newline: 400 (reserved path, bad slug, empty
// manifest), 403 ("owned by <email>"), 404 ("not found").

// A share file path: "<slug>/<relative path>". Slugs never start with "_".
export type FilePath = string

export interface ApiEndpoints {
  // install script of the `share` CLI
  'GET /_cli': { response: string }
  // Claude Code skill (SKILL.md)
  'GET /_skill': { response: string }
  // without prefix: slugs of your shares (admin: all), sorted.
  // with ?prefix=<slug>/ or <slug>/<dir>/: full paths of the files under it.
  'GET /_list': { query: { prefix?: string }; response: Lines<string> }
  // Versioned publish: 1. ask which blobs the store lacks, 2. upload them,
  // 3. commit the manifest. The commit makes a new version live in one step;
  // until then readers see the previous version. 501 on the KV store.
  // sha256 hex lines in, the ones not stored out
  'POST /_blobs/missing': { body: Lines<string>; response: Lines<string> }
  // one blob; 400 when the body's sha256 differs
  'PUT /_blobs/<sha256>': { body: ArrayBuffer; response: 'ok\n' }
  // 400 on a bad path, duplicate path or missing blob; 403 owned by another
  // user; 409 on a concurrent publish to the same slug (retry)
  'POST /_publish/<slug>': { body: PublishRequest; response: PublishResponse }
  // Legacy publish (bash CLI): PUT each file, then finalize. The PUTs fill a
  // pending version; finalize makes it live. The first PUT to a slug claims
  // it for the caller.
  'PUT /<slug>/<path>': { body: ArrayBuffer; response: 'ok\n' }
  // after the uploads: newline-separated relative paths of the share; 400
  // when one of them was not uploaded (the previous version stays live)
  'POST /_finalize/<slug>': { body: Lines<string>; response: 'ok\n' }
  // raw bytes of one file
  'GET /<slug>/<path>': { response: ArrayBuffer }
  // who viewed the share (owner or admin)
  'GET /<slug>/_views': { response: Lines<ViewLine> }
  // remove the share and all its files; response "deleted <n>\n"
  'DELETE /<slug>/': { response: string }
  // admin: rebuild manifests and owners; response "migrated <n>\n"
  'POST /_migrate': { response: string }
  // your CLI tokens, newest first (JSON)
  'GET /_api/tokens': { response: TokenInfo[] }
  // revoke a token of yours; "current": the token of this request
  // (`share logout`). 404 {"error"} when no live token has that id.
  'DELETE /_api/tokens/<id>': { response: { revoked: string } }
  // `share login`, no bearer token (RFC 8628 device flow). Open
  // verification_uri_complete, then poll /_device/token every `interval`
  // seconds until it returns the token.
  'POST /_device': { body: { name?: string }; response: DeviceStartResponse }
  // 400 with error authorization_pending (poll again), access_denied or
  // expired_token (start again); 200 with the token
  'POST /_device/token': { body: { device_code: string }; response: DeviceTokenResponse }
}

export interface TokenInfo {
  id: string
  name: string
  // ms since the epoch
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  revoked_at: number | null
}

export interface DeviceStartResponse {
  device_code: string
  // XXXX-XXXX
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
  // the API (app host) and where share links point (content host)
  base_url: string
  content_url: string
}

export type DeviceTokenResponse =
  | { error: 'authorization_pending' | 'access_denied' | 'expired_token' }
  | { token: string; email: string; name: string }

export interface PublishRequest {
  files: { path: string; sha256: string; contentType?: string }[]
  message?: string
}

export interface PublishResponse {
  slug: string
  version: number
}

// newline-separated values, each line ends with "\n"
export type Lines<_T> = string

// one line of GET /<slug>/_views: tab-separated email, view count, ISO time
// of the last view; newest first
export interface ViewLine {
  email: string
  count: number
  last: string
}

export function parseLines(body: string): string[] {
  return body.split('\n').filter(Boolean)
}

export function parseViews(body: string): ViewLine[] {
  return parseLines(body).map((l) => {
    const [email, count, last] = l.split('\t')
    return { email, count: Number(count), last }
  })
}

// encodeURIComponent per segment, "/" kept
export function filePathUrl(base: string, path: FilePath): string {
  return `${base.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`
}
