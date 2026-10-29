// mb-shares worker: private gist-like file store.
// Viewers authenticate with Google (only verified @ALLOWED_DOMAIN accounts);
// the `share` CLI publishes with a bearer token. Every user gets their own
// token (minted at /_token) and sees only their own shares at `/`;
// ADMIN_EMAIL sees everything. Share slugs carry a random suffix.
//
// Modules:
//   hosts.ts        which host a request is for, and its entry point
//   routes.ts       request dispatch: bearer API, login, browser views
//   auth.ts         Google OAuth, session cookies, CLI tokens
//   api/cli.ts      bearer-token endpoints (publish, list, delete, views)
//   web/serve.ts    browser pages: listing, stats, token page, share content
//   render/         HTML shell and per-file-type renderers
//   store/          ShareStore interface and its adapters
//   api-types.ts    HTTP API request/response types, shared with the CLI

import type { Env } from './env'
import { entryFor } from './hosts'

export type { Env } from './env'

export default {
  async fetch(req, env, ctx) {
    try {
      return await entryFor(new URL(req.url), env)(req, env, ctx)
    } catch (e) {
      // mainly the KV free-tier "list() limit exceeded for the day" -- show
      // something human instead of Cloudflare's 1101 screen
      return new Response(`mb-shares hiccup: ${(e as Error).message}\n(daily KV quota? resets midnight UTC)\n`,
        { status: 503, headers: { 'retry-after': '3600' } })
    }
  },
} satisfies ExportedHandler<Env>
