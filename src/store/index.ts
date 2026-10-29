import type { Env } from '../env'
import { KvStore } from './kv'
import type { ShareStore } from './types'

export type { Manifest, ShareStore, ShareSummary, ViewLog } from './types'

// The one place that picks the adapter.
export function storeFor(env: Env): ShareStore {
  return new KvStore(env)
}
