// Storage behind the routes. The routes see share files and share metadata
// only, never KV keys or D1 rows. Adapters: store/d1r2.ts (R2 blobs + D1
// metadata, versioned), store/kv.ts (the inherited KV layout, env.pub).
//
// Paths: a share file is "<slug>/<relative path>". A prefix is "<slug>/" or
// "<slug>/<subdir>/", always with the trailing slash.

export interface Manifest {
  files: string[] // relative paths, sorted
  t: number // last finalize, ms since epoch
  o: string // owner email
}

export interface ShareSummary {
  n: number // file count
  t: number // newest timestamp, 0 when unknown
  o?: string // owner email; undefined on legacy shares (= ADMIN_EMAIL)
  pub?: boolean // owner marked it public (SHR-9); D1+R2 only
  title?: string // D1+R2 only
}

// one audit log row, newest first from audit()
export interface AuditEntry {
  at: number // ms since epoch
  actor: string
  action: string
  share: string | null
}

import type { Collection, CollectionUpdate, ShareAttrs, ShareInfo, ShareManifest, VersionInfo } from '../api-types'

export type { Collection, CollectionUpdate, ShareAttrs, ShareInfo, ShareManifest, VersionInfo }

// one file of a versioned publish (POST /_publish/<slug>)
export interface CommitFile {
  path: string // relative to the share
  sha256: string // hex; the blob must be uploaded first
  contentType?: string
}

// a request error the API answers with `status` and the message
export class StoreError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

// email -> view count and last view (ms)
export type ViewLog = Record<string, { n: number; last: number }>

export interface ShareStore {
  // file bodies, or null when the file does not exist
  getText(path: string): Promise<string | null>
  getBytes(path: string): Promise<ArrayBuffer | null>
  getStream(path: string): Promise<ReadableStream | null>
  putFile(path: string, body: ArrayBuffer, uploader: string): Promise<void>

  // owner of a slug, or null when nobody has claimed it
  owner(slug: string): Promise<string | null>
  claim(slug: string, owner: string): Promise<void>

  // heal (default true): rebuild a missing manifest from the stored files.
  // heal false is a cheap existence check for redirects.
  manifest(slug: string, opts?: { heal?: boolean }): Promise<Manifest | null>
  // record the files of a publish, written after the uploads by `by`.
  // attrs: QueryStore only, the caller refuses them on other stores.
  finalize(slug: string, files: string[], owner: string, by: string, attrs?: ShareAttrs): Promise<Manifest>
  // full paths of the files under a prefix, from the slug's manifest
  filesUnder(prefix: string): Promise<string[]>
  // every share, by slug
  shares(): Promise<Map<string, ShareSummary>>
  // remove the share, its files and its bookkeeping; returns the file count.
  // by: who deletes it, for the audit log (D1+R2)
  deleteShare(slug: string, by?: string): Promise<number>
  // rebuild every manifest and owner from the stored files; returns the
  // share count
  rebuildAll(): Promise<number>

  views(slug: string): Promise<ViewLog | null>
  recordView(slug: string, email: string): Promise<void>
  // publish count per email
  pushes(): Promise<Record<string, number>>
  countPush(who: string): Promise<void>

  // Versioned publish, D1+R2 only: blobs first, then one commit that makes
  // a new version live. Absent on the KV adapter.
  // shas the store does not have
  missingBlobs?(shas: string[]): Promise<string[]>
  putBlob?(sha: string, body: ArrayBuffer): Promise<void>
  // returns the new version number
  commit?(slug: string, files: CommitFile[], by: string, message?: string, attrs?: ShareAttrs): Promise<number>

  // Public shares (SHR-9), D1+R2 only. isPublic is false on the KV adapter.
  isPublic(slug: string): Promise<boolean>
  // set the public bit and add an audit row, in one batch
  setPublic?(slug: string, on: boolean, by: string): Promise<void>
  audit?(limit: number): Promise<AuditEntry[]>
}

// filters of queryShares; all given ones must match
export interface ShareFilter {
  collection?: string
  owner?: string
  meta?: Record<string, string> // key -> JSON value or its string form
  limit: number
  before?: number
}

// Collections, share attributes and JSON reads (SHR-12). D1+R2 only.
export interface QueryStore {
  collections(prefix?: string): Promise<Collection[]>
  collection(slug: string): Promise<Collection | null>
  putCollection(slug: string, update: CollectionUpdate, by: string): Promise<Collection>
  // attributes of a share without a publish
  setAttrs(slug: string, attrs: ShareAttrs, by: string): Promise<void>
  queryShares(filter: ShareFilter): Promise<ShareInfo[]>
  // null when the share has no live version
  share(slug: string): Promise<ShareInfo | null>
  versions(slug: string): Promise<VersionInfo[]>
  // live version when version is undefined; null when there is none
  shareManifest(slug: string, version?: number): Promise<ShareManifest | null>

  // Web app (SHR-15). Full text search over slug, title, collection, owner,
  // file paths and metadata; every word is a prefix. Best match first.
  search(q: string, owner: string | undefined, limit: number): Promise<ShareInfo[]>
  // bytes of a blob from a manifest, any version
  blobBytes(sha: string): Promise<ArrayBuffer | null>
  // new slug for the share with all its versions; audit logged
  rename(slug: string, to: string, by: string): Promise<void>
  // new owner; audit logged. The caller checks the email.
  transfer(slug: string, to: string, by: string): Promise<void>
}

export function isQueryStore(s: ShareStore): s is ShareStore & QueryStore {
  return 'queryShares' in s
}
