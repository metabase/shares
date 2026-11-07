import type { Env } from '../env'
import { D1R2Store } from './d1r2'
import { KvStore } from './kv'
import type { ShareStore } from './types'

export type { Access, AuditEntry, CommitFile, Manifest, QueryStore, ShareAttrs, ShareFilter, ShareInfo, ShareStore, ShareSummary, ViewLog, Visibility } from './types'
export { VISIBILITIES, baseSlug, canRead, isQueryStore, pinned, StoreError } from './types'

// The one place that picks the adapter. env.pub binds only KV.
export function storeFor(env: Env): ShareStore {
  return env.DB && env.BLOBS ? new D1R2Store(env) : new KvStore(env)
}
