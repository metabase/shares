// HTTP API of the Worker, for clients (the TS CLI, SHR-7). No imports: the
// CLI imports this file without the Worker's runtime types.
//
// Every endpoint but /_cli, /_skill and /_device/* takes
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
  // when one of them was not uploaded (the previous version stays live).
  // The query sets the share's attributes in the same commit: `collection`,
  // `title`, and `meta=<key>=<value>` (repeatable; the value is a JSON
  // string).
  'POST /_finalize/<slug>': { query: FinalizeQuery; body: Lines<string>; response: 'ok\n' }
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
  // admin: service tokens for agents and CI (SHR-13). POST makes one; the
  // token is in the response only. ?kind=service on GET lists all of them,
  // on DELETE revokes one of them.
  'POST /_api/tokens': { body: ServiceTokenCreate; response: ServiceTokenCreated }
  'GET /_api/tokens?kind=service': { response: ServiceTokenInfo[] }
  'DELETE /_api/tokens/<id>?kind=service': { response: { revoked: string } }
  // `share login`, no bearer token (RFC 8628 device flow). Open
  // verification_uri_complete, then poll /_device/token every `interval`
  // seconds until it returns the token.
  'POST /_device/code': { body: { name?: string }; response: DeviceStartResponse }
  // 400 with error authorization_pending (poll again), access_denied or
  // expired_token (start again); 200 with the token
  'POST /_device/token': { body: { device_code: string }; response: DeviceTokenResponse }
  // make a share public (readable without login) or private. "on": owner
  // only, 403 "public sharing is disabled" when the server flag is off.
  // "off": owner or admin. 404 when the slug does not exist; 501 on KV.
  'POST /_public/<slug>': { body: 'on' | 'off'; response: 'on\n' | 'off\n' }
  // admin: newest audit rows (?limit=1..1000, default 100)
  'GET /_audit': { query: { limit?: number }; response: Lines<AuditLine> }

  // JSON query API (D1+R2 store; 501 on KV). Bodies and responses are JSON;
  // errors are ApiError with the status. Collection slugs can contain "/"
  // (metareview/metabase-85416): the rest of the path is the slug.
  // collections, newest activity first; ?prefix= matches the slug start
  'GET /_api/collections': { query: { prefix?: string }; response: Collection[] }
  'GET /_api/collections/<slug>': { response: Collection }
  // create (owner = caller) or update (owner or admin)
  'PUT /_api/collections/<slug>': { body: CollectionUpdate; response: Collection }
  // shares with a live version, newest first. Without `collection`, a
  // non-admin sees only their own shares.
  'GET /_api/shares': { query: ShareQuery; response: ShareInfo[] }
  'GET /_api/shares/<slug>': { response: ShareInfo }
  // set attributes without a publish (owner or admin)
  'POST /_api/shares/<slug>': { body: ShareAttrs; response: ShareInfo }
  // every version, newest first, pending ones too
  'GET /_api/shares/<slug>/versions': { response: VersionInfo[] }
  // files of the live version, or of ?version=<n>
  'GET /_api/shares/<slug>/manifest': { query: { version?: number }; response: ShareManifest }
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

// A service token acts as agent:<name>: it is the created_by of its
// versions, and the owner of the shares it makes unless on_behalf_of names a
// person. It can only publish (/_blobs, /_publish), read and delete shares,
// and read and write collections, in scope; other routes give 403. Scopes:
// "read:<collection>" or "write:<collection>" (write implies read); a
// trailing "*" matches any rest, "write:metareview/*". A share is in scope
// when its collection is.
export interface ServiceTokenCreate {
  name: string
  scopes: string[]
  on_behalf_of?: string | null
  // default and maximum 365
  expires_days?: number
}

export interface ServiceTokenCreated {
  id: string
  token: string
  name: string
  scopes: string[]
  on_behalf_of: string | null
}

export interface ServiceTokenInfo extends TokenInfo {
  // the admin who made it
  created_by: string
  scopes: string[]
  on_behalf_of: string | null
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

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

// Free-form share attributes. Omitted fields stay as they are. A null
// collection or title clears it; a null meta value removes that key. A
// collection that does not exist is made, owned by the caller. Anyone can
// publish into any collection.
export interface ShareAttrs {
  title?: string | null
  collection?: string | null
  meta?: Record<string, JsonValue>
}

export interface PublishRequest extends ShareAttrs {
  files: { path: string; sha256: string; contentType?: string }[]
  message?: string
}

export interface FinalizeQuery {
  collection?: string
  title?: string
  meta?: string[] // "<key>=<value>"
}

export interface ApiError {
  error: string
}

export interface Collection {
  slug: string
  title: string | null
  owner: string
  meta: Record<string, JsonValue>
  shares: number // shares with a live version
  createdAt: number // ms since epoch
  updatedAt: number // last change or publish into it
}

export interface CollectionUpdate {
  title?: string | null
  meta?: Record<string, JsonValue> // replaces the collection's meta
}

// query string of GET /_api/shares
export interface ShareQuery {
  collection?: string
  owner?: string
  // meta.<key>=<value>, repeatable, all must match. The value matches the
  // JSON value or its string form: meta.pr=85416 matches 85416 and "85416".
  [meta: `meta.${string}`]: string
  limit?: number // default 100, at most 1000
  before?: number // updatedAt of the last row of the previous page
}

export interface ShareInfo {
  slug: string
  title: string | null
  owner: string
  collection: string | null
  meta: Record<string, JsonValue>
  version: number // the live version
  fileCount: number
  totalBytes: number
  createdAt: number
  updatedAt: number
}

export interface VersionInfo {
  version: number
  state: 'pending' | 'complete'
  live: boolean
  createdBy: string
  createdAt: number
  fileCount: number
  totalBytes: number
  message: string | null
}

export interface ShareManifest {
  slug: string
  version: number
  files: { path: string; sha256: string; size: number; contentType: string | null }[]
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

// one line of GET /_audit: tab-separated ISO time, actor email, action
// (public.on, public.off), share slug
export interface AuditLine {
  at: string
  actor: string
  action: string
  share: string
}

export function parseAudit(body: string): AuditLine[] {
  return parseLines(body).map((l) => {
    const [at, actor, action, share] = l.split('\t')
    return { at, actor, action, share }
  })
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
