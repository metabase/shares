// HTTP API of the Worker, for clients (the TS CLI, SHR-7). No imports: the
// CLI imports this file without the Worker's runtime types.
//
// Every endpoint takes `Authorization: Bearer <token>`. A missing or bad
// token gives 403 "forbidden". Bodies are text unless noted. Errors are
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
}

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
