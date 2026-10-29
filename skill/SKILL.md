---
name: mb-shares
description: Publish files, dirs, or stdin to the private mb-shares worker (mb-shares.escherize.workers.dev) via the `share` CLI, read a pasted share link, or pull a share's files back down. Use when the user wants to share a file/doc/report/code with coworkers, read/download an existing share or an mb-shares URL someone sent, says "share this", "mb-shares", "publish this for the team", or wants a private link viewable by @metabase.com Google accounts.
---

# mb-shares

Private gist-alike: Cloudflare Worker + KV. Viewers sign in with a
@metabase.com Google account; publishing uses a bearer token. URLs are safe
to paste anywhere (auth-gated), slugs carry a random suffix so they are not
guessable.

- CLI: `share` (repo `bin/share`, symlinked to `~/bin/share`)
- Worker: `~/dv/mb-shares-worker` -> https://github.com/escherize/mb-shares-worker
- Config: `~/.config/mb-shares/env` (BASE_URL = API host, CONTENT_URL = share link host, UPLOAD_TOKEN — never commit)
- This skill: repo `skill/SKILL.md`, served at `/_skill`, installable via the
  snippet on `/_token`

## Usage

```bash
share thing.md                   # publish one file -> prints URL instantly
share ./some-dir                 # whole directory, slug = dir name
share ./dir/*                    # glob form: one share named for parent dir
share ./dir cool-name            # custom name (still gets random suffix)
share -x report.md standup       # exact slug -> /standup/, no suffix; fails if
                                 #   taken. Guessable by any logged-in viewer --
                                 #   only for shares meant to be findable
pbpaste | share -f slides.html   # stdin; .html/.md becomes the share's index
share -e ./dir cool-name-a3f2b   # overwrite existing share, same URL
share                            # list all shares
share rm cool-name-a3f2b         # delete
share download cool-name-a3f2b   # pull all files into ./cool-name-a3f2b/
share download cool-name-a3f2b x # ... into ./x/ (nested paths preserved)
share cat <url-or-slug>[/file]   # print contents to stdout; pasted URL ok as-is
share --local <url>[/file]       # url -> local path it was published from
share views <url-or-slug>        # who viewed a share (email, count, last)
```

## What to share

Prefer a single `.md` or `.html` doc — it becomes the share's index and the
URL renders it directly. Markdown gets full rendering including ```mermaid
and ```reladraw fences as inline diagrams (theme-aware). HTML is served as-is, so
interactive pages work, and they can `fetch()` sibling files in the same
share (non-browser requests get raw bytes). Directory shares work too
(nested paths, listing page, zip download) — but go easy on them: share a
whole directory only when the user asks or the files genuinely travel
together, not as a default.

To read a share (e.g. the user pastes an mb-shares URL): `share cat <url>`.
Multi-file shares print with `==> name <==` headers. Do NOT WebFetch share
URLs — the Google login wall blocks it; `share cat` authenticates with the
bearer token.

Every publish is also mirrored to `~/.local/share/mb-shares/<slug>/` — grep
there to find what was previously shared (e.g. "which share had X in it").

`share --local <url>` answers "where on disk is this share from?": prints the
source path recorded at publish time (`~/.local/share/mb-shares/.sources`),
falling back to the mirror copy when the source is gone, the share predates
source recording, or it was published from another machine.

View analytics: each browser visit is logged per share (`_views/<slug>` in
KV, deduped to one view per viewer per 30min; raw fetches and hover previews
don't count). The home page shows a "N viewers" column (hover for who/when);
`share views <slug>` prints the same from the CLI. Owner or admin only.

Notes:
- A single `.md`/`.html` file becomes the share's `index`, so the slug URL
  renders it directly. Multi-file shares show a listing with a
  "download all (.zip)" link (`/slug/_zip`); single-file shares skip the
  listing and jump straight to the file.
- `-e` needs the full slug (with suffix) from `share`.
- `-f` composes with `-e`: `pbpaste | share -e -f x.html x-a1b2c3`.

## Before you share a doc: lead with the question it answers

Any `.md`/`.html` doc meant for a human reader should open with the one
question it answers, before anything else. A reader who lands on the URL cold
should know in one line whether this doc is for them. Put it as a blockquote
right under the title:

```markdown
# <title>

> **Question this answers:** <the single concrete question, with the specifics
> baked in — the branch, the commit, the dataset, the decision at stake — not a
> vague topic>.
```

Make it a real question with the specifics in it ("At commit X on branch Y,
which files are still vulnerable?"), not a topic label ("Security audit"). If
you can't state the question in one sentence, the doc isn't scoped yet — fix
that before sharing. Skip this only for raw data/code shares (`.csv`, `.clj`,
logs) where there is no prose to host it.

## How files render

- `.md` -> styled page (marked). Headings and ordered-list items get hover
  `#` deep-link anchors (`#steps`, `#item-2-2` = step 2, sub-item b).
  ```mermaid fences render as inline diagrams (lazy CDN load, dark/light
  theme follows the page; CDN failure degrades to highlighted code).
  ```reladraw fences (https://github.com/reladraw/reladraw) render the same
  way, for diagrams where you say where things go (`b right of a`). Syntax:
  https://github.com/reladraw/reladraw/blob/main/SYNTAX.md. Check a fence
  before sharing with `npx reladraw x.reladraw -o -` (errors name the line);
  a fence that fails to parse stays code on the page.
- `.json` -> pretty-printed + highlighted; `.jsonl`/`.ndjson` -> one pretty
  record per block. Malformed JSON shows raw.
- `.csv` -> rendered table (first 1000 rows; quoted fields handled).
- Known types (html, css, js, txt, images, pdf, mp4, wasm) -> served raw;
  browser shows them natively.
- Any other text file (`.clj`, `.py`, `.gleam`, `.lis`, unknown ext) ->
  highlighted `<pre>` page, title = filename, highlight.js from CDN.
  Grammar hints live in `CODE_LANGS` in `src/index.js`.
- Binary without a known type (null byte in first 8KB) -> download.
- Every `<pre>` gets a copy button; wide pre/tables expand past the 52rem
  prose column up to viewport width before scrolling internally.
- Rendered pages auto-refresh: a 15s poll compares an embedded content
  fingerprint and reloads open tabs when a `share -e` push changes it.
- Themes: auto/light/dark/tokyo/nord — dropdown on the admin page,
  persisted in localStorage, applies to all rendered pages + hljs colors.
- Pretty views only serve on browser navigation (`Accept: text/html`);
  `fetch()`/curl always get raw bytes, so html shares can load their own
  data files.

## Worker dev

```bash
cd ~/dv/mb-shares-worker
bun x wrangler deploy            # deploy (no build step)
```

If wrangler dies with "Cannot find module 'esbuild'": stale bunx cache —
`rm -rf $TMPDIR/bunx-501-wrangler@latest` and retry.

Deploys can serve stale code for ~30s (workers.dev propagation) — retest
before debugging a "broken" change.

Troubleshooting: 403 on publish -> UPLOAD_TOKEN mismatch (re-set via
`bun x wrangler secret put UPLOAD_TOKEN`, mirror in the env file). Login
loop -> viewer's Google account is not @metabase.com.
