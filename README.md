# shares

Private file sharing for Metabase. `share <path>` publishes files and prints a link that only
@metabase.com Google accounts can open. Agents publish runs into collections with metadata and
read them back as JSON.

- Share links: `https://shares.metabase.fyi/<slug>/` (content host: user files only)
- App: `https://app.shares.metabase.fyi` (API, login, tokens, share list, search)

User HTML runs only on the content host, never on the origin that holds tokens, the API or the UI.

## Install

```sh
curl -fsSL https://app.shares.metabase.fyi/install.sh | sh   # binary to ~/.local/bin/share
share login                                                  # approve in the browser
share report.md                                              # prints the link
```

Without a binary for the platform (Alpine, Windows): `npm i -g @metabase/shares` (Node 20+).
`share -h` lists every command.

The config is `~/.config/shares/config` (mode 0600, written by `share login`). `SHARES_URL`,
`SHARES_CONTENT_URL` and `SHARES_TOKEN` in the environment override it, for CI and agents.

## Claude Code skill

```sh
mkdir -p ~/.claude/skills/mb-shares
curl -fsS https://app.shares.metabase.fyi/_skill -o ~/.claude/skills/mb-shares/SKILL.md
```

The source is [skill/SKILL.md](skill/SKILL.md); the worker serves it at `/_skill`. The skill
keeps the name `mb-shares`, so the install replaces the skill of the old mb-shares worker.
Agents use `--json` on any command: stdout is one JSON value, errors too.

## Agents and CI

An admin makes a scoped service token:

```sh
share token create metareview --scope 'write:metareview/*'
SHARES_URL=https://app.shares.metabase.fyi SHARES_TOKEN=shr_... \
  share --json --collection metareview/pr-1 --meta pr=1 ./out
share api 'shares?collection=metareview/pr-1'
```

The publish protocol (`/_blobs/missing`, `/_blobs/<sha256>`, `/_publish/<slug>`) and all API
types are in [src/api-types.ts](src/api-types.ts). [docs/metareview.md](docs/metareview.md) is
the metareview contract.

## Develop

```sh
bun install
bun run db:migrate:local          # local D1
bun run dev                       # wrangler dev: local D1 + R2, one host for content and app
bun run test                      # tsc (worker, cli) + worker tests + CLI unit and e2e tests
```

Layout:

| Path | What |
| --- | --- |
| `src/index.ts`, `src/routes.ts` | Worker entry; `contentHost`, `appHost`, `handle` |
| `src/auth.ts`, `src/tokens.ts` | Google OAuth, sessions, CLI and service tokens, device flow |
| `src/api/` | bearer API: `cli.ts` (files), `json.ts` (`/_api`), `service.ts` (service tokens) |
| `src/store/` | `ShareStore`; `d1r2.ts` is the versioned R2 + D1 store |
| `src/web/`, `src/render/` | web app pages; file renderers (md, csv, json, code) |
| `src/api-types.ts` | HTTP API types, shared with the CLI |
| `cli/` | the TypeScript `share` CLI, `install.sh`, `build.ts` (bun binaries, npm package) |
| `bin/share` | the bash CLI of mb-shares, still served at `/_cli` |
| `migrations/` | D1 schema |
| `skill/SKILL.md` | the Claude Code skill |

## Deploy

CI (`.github/workflows/ci.yml`) tests every pull request without secrets. A push to `main`
applies D1 migrations and runs `wrangler deploy --env metabase` to the Metabase Cloudflare
account, through the GitHub environment `production`. Worker secrets:
`bun x wrangler secret put <NAME> --env metabase` (`SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`).

A tag `cli-v<semver>` runs `.github/workflows/release.yml`: CLI binaries to a GitHub release,
the npm package to `@metabase/shares`.

Public sharing (`share --public`) is off unless the var `PUBLIC_SHARING = "1"` is set.

This repository is public: no secrets in code or in workflows that fork pull requests can run.
