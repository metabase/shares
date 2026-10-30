---
name: mb-shares
description: Publish files, dirs, or stdin to Metabase shares (shares.metabase.fyi, private to @metabase.com Google accounts) with the `share` CLI, read a pasted share link, pull a share's files back down, or publish agent output into a collection with metadata. Use when the user wants to share a file/doc/report/code with coworkers, read/download an existing share or a shares.metabase.fyi / mb-shares URL someone sent, says "share this", "mb-shares", "publish this for the team", or wants a private link viewable by @metabase.com Google accounts.
---

# Metabase shares

Private gist-alike on Cloudflare (Worker + D1 + R2), repo
https://github.com/metabase/shares. Viewers sign in with a @metabase.com
Google account; the CLI uses a bearer token. URLs are safe to paste anywhere
(login-gated); slugs carry a random suffix, so they are not guessable.

- Share links: `https://shares.metabase.fyi/<slug>/` (content host: user files only)
- App: `https://app.shares.metabase.fyi` (API, login, tokens, share list and search)
- This skill: served at `<app>/_skill`. Update it with
  `mkdir -p ~/.claude/skills/mb-shares && curl -fsS https://app.shares.metabase.fyi/_skill -o ~/.claude/skills/mb-shares/SKILL.md`

## Setup

```bash
command -v share && share whoami        # already set up?
curl -fsSL https://app.shares.metabase.fyi/install.sh | sh   # binary to ~/.local/bin/share
share login                             # opens the browser; approve; token saved
```

`share login` prints a URL and a code. In an agent session, show both to the
user and wait: the user approves in the browser, then the command saves the
token to `~/.config/shares/config` (mode 0600) and exits. Without a binary for
the platform: `npm i -g @metabase/shares` (Node 20+).

Old mb-shares setup (`~/.config/mb-shares/env`, a token from `/_token` on
mb-shares.escherize.workers.dev): run `share login` once. The new CLI
still reads the old env file until then.

Agents and CI without a login use the environment instead of the config:
`SHARES_URL=https://app.shares.metabase.fyi SHARES_TOKEN=shr_...`. An admin
makes a scoped service token for them (see Service tokens).

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
share -e ./dir cool-name-a3f2b   # new version of an existing share, same URL
share                            # list your shares
share rm cool-name-a3f2b         # delete
share download cool-name-a3f2b   # pull all files into ./cool-name-a3f2b/
share download cool-name-a3f2b x # ... into ./x/ (nested paths preserved)
share cat <url-or-slug>[/file]   # print contents to stdout; pasted URL ok as-is
share ls <url-or-slug>           # files in a share
share log <url-or-slug>          # versions, newest first
share --local <url>[/file]       # url -> local path it was published from
share views <url-or-slug>        # who viewed a share (email, count, last)
share whoami                     # account of the saved token
share logout                     # revoke this machine's token
share -h                         # full help
```

Each publish is a new version; the share URL shows the newest, and
`<slug>@<n>/` is version n. `share log` lists them.

## For agents: --json

Add `--json` to any command: stdout is one JSON value, errors too
(`{"error": "...", "status": 403}`, exit code non-zero). Parse it instead of
the human output.

```bash
share --json report.md                # {"url","slug","version","files":[...],"public"}
share --json cat <url>                # [{"path","content"}, ...]
share --json ls <slug>                # file list
share --json log <slug>               # [{version, message, ...}, ...]
share --json whoami                   # {email, ..., base_url, content_url}
url=$(share --json ./out | jq -r .url)
```

To read a share (e.g. the user pastes a share URL): `share cat <url>`.
Multi-file shares print with `==> name <==` headers. Do NOT WebFetch share
URLs: the Google login wall blocks it; `share cat` sends the bearer token.

## Collections and metadata

Agent systems publish runs into collections with metadata, then query them.

```bash
share --collection metareview/pr-85416 --title "Run 1" --meta pr=85416 \
      --message "r1 4f1c..." ./out           # made if missing
share api collections                        # GET /_api/collections as JSON
share api 'shares?collection=metareview/pr-85416&meta.pr=85416'
share api shares/<slug>/versions
```

The web app lists, searches (`?q=`) and filters (`?c=<collection>`) shares
at `https://app.shares.metabase.fyi/`; `/_s/<slug>` shows one share with its
versions and metadata.

## Service tokens (admin)

```bash
share token create metareview --scope 'write:metareview/*' [--on-behalf-of a@metabase.com] [--days 365]
share token ls --service
share token revoke <id> --service
```

The token is shown once. Scopes are `read:<collection>` and
`write:<collection>`; a trailing `*` matches any rest. A service token can
publish only into its collections, owner `agent:<name>`.

## Public shares

Off by default; works only if the server enables it. `share -p file.md` or
`share public <slug> on|off` makes a share open without login. Ask the user
before making anything public.

## What to share

Prefer a single `.md` or `.html` doc: it becomes the share's index and the
URL renders it directly. Markdown gets full rendering including ```mermaid
and ```reladraw fences as inline diagrams (theme-aware). HTML is served as-is,
so interactive pages work, and they can `fetch()` sibling files in the same
share (non-browser requests get raw bytes). Directory shares work too (nested
paths, listing page, zip download), but share a whole directory only when the
user asks or the files genuinely travel together.

Every publish is also mirrored to `~/.local/share/mb-shares/<slug>/`: grep
there to find what was previously shared ("which share had X in it").
`share --local <url>` prints the source path recorded at publish time, or the
mirror copy when the source is gone or was on another machine.

View analytics: each browser visit is logged per share (one view per viewer
per 30 min; raw fetches and hover previews do not count). `share views
<slug>` prints them. Owner or admin only.

Notes:
- A single `.md`/`.html` file publishes as `index.md`/`index.html`, so the
  slug URL renders it. Multi-file shares show a listing with a
  "download all (.zip)" link (`/slug/_zip`).
- `-e` needs the full slug (with suffix) from `share`.
- `-f` composes with `-e`: `pbpaste | share -e -f x.html x-a1b2c3`.

## Before you share a doc: lead with the question it answers

Any `.md`/`.html` doc meant for a human reader should open with the one
question it answers. A reader who lands on the URL cold should know in one
line whether this doc is for them. Put it as a blockquote under the title:

```markdown
# <title>

> **Question this answers:** <the single concrete question, with the specifics
> baked in — the branch, the commit, the dataset, the choice at stake — not a
> vague topic>.
```

Make it a real question with the specifics in it ("At commit X on branch Y,
which files are still vulnerable?"), not a topic label ("Security audit"). If
you can't state the question in one sentence, the doc isn't scoped yet. Skip
this only for raw data/code shares (`.csv`, `.clj`, logs).

## How files render

- `.md` -> styled page (marked). Headings and ordered-list items get hover
  `#` deep-link anchors. ```mermaid fences render as inline diagrams (CDN,
  theme follows the page; CDN failure degrades to highlighted code).
  ```reladraw fences (https://github.com/reladraw/reladraw) render the same
  way. Syntax: https://github.com/reladraw/reladraw/blob/main/SYNTAX.md.
  Check a fence with `npx reladraw x.reladraw -o -` (errors name the line);
  a fence that fails to parse stays code on the page.
- `.json` -> pretty-printed + highlighted; `.jsonl`/`.ndjson` -> one record
  per block. Malformed JSON shows raw.
- `.csv` -> table (first 1000 rows).
- Known types (html, css, js, txt, images, pdf, mp4, wasm) -> served raw.
- Other text files (`.clj`, `.py`, unknown ext) -> highlighted `<pre>` page.
- Binary without a known type -> download.
- Rendered pages auto-refresh when a `share -e` push changes the content.
- Pretty views only serve on browser navigation (`Accept: text/html`);
  `fetch()`/curl get raw bytes.

## Troubleshooting

- `401`: no token, or it was revoked or expired: `share login`.
- `403` on publish: the token cannot write there (service token scope, or the
  share belongs to someone else).
- `409` on publish: a concurrent publish to the same share: publish again.
- Login loop in the browser: the Google account is not @metabase.com.
