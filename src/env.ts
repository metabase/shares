// Bindings, vars and secrets of the Worker (wrangler.toml).
export interface Env {
  // share files and bookkeeping keys; the KV store adapter (store/kv.ts)
  SHARES: KVNamespace
  // metadata (migrations/); the R2+D1 store adapter uses it (SHR-4)
  DB: D1Database
  // file blobs; the R2+D1 store adapter uses it (SHR-4)
  BLOBS: R2Bucket

  GOOGLE_CLIENT_ID: string
  ALLOWED_DOMAIN: string
  ADMIN_EMAIL: string
  // "1": public read-only deploy (env.pub), no Google login
  PUBLIC?: string
  // hostnames of the two hosts (SHR-5). When a request host matches neither,
  // one origin serves everything.
  CONTENT_HOST?: string
  APP_HOST?: string

  // secrets
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET: string
  UPLOAD_TOKEN?: string
}
