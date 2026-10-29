// Bindings, vars and secrets of the Worker (wrangler.toml).
export interface Env {
  // share files and bookkeeping keys; the KV store adapter (store/kv.ts),
  // used when DB or BLOBS is not bound (env.pub); not bound in env.metabase
  SHARES?: KVNamespace
  // metadata (migrations/); the D1+R2 store adapter (store/d1r2.ts)
  DB: D1Database
  // file blobs at blobs/<sha256>; the D1+R2 store adapter
  BLOBS: R2Bucket

  GOOGLE_CLIENT_ID: string
  ALLOWED_DOMAIN: string
  ADMIN_EMAIL: string
  // "1": public read-only deploy (env.pub), no Google login
  PUBLIC?: string
  // "1": owners can mark a share public, readable without login (SHR-9,
  // decision public-sharing-flag). Unset: off, the API refuses the flag.
  PUBLIC_SHARING?: string
  // hostnames of the two hosts (SHR-5). When a request host matches neither,
  // one origin serves everything.
  CONTENT_HOST?: string
  APP_HOST?: string

  // secrets
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET: string
  UPLOAD_TOKEN?: string
}
