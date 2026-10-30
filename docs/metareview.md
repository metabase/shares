# metareview publish contract

metareview (metabase/metareview) publishes each finished review run to shares. The store stays
generic: shares holds the run folder and metadata, not a findings model.

## Token

The admin makes one service token:

```sh
curl -X POST https://app.shares.metabase.fyi/_api/tokens -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "metareview", "scopes": ["write:metareview/*"]}'
```

metareview reads it from `METAREVIEW_SHARES_TOKEN`, and the app host from `METAREVIEW_SHARES_URL`
(`https://app.shares.metabase.fyi`). Without both, metareview does not publish.

## Layout

| Thing | Value | Example |
| --- | --- | --- |
| Collection, one per pull request | `metareview/<owner>-<repo>/pr-<n>`, lowercase | `metareview/metabase-metabase/pr-85416` |
| Share, one per pull request | `metareview-<owner>-<repo>-pr-<n>` | `metareview-metabase-metabase-pr-85416` |
| Version, one per run | next version number; message `<run id> <head sha>` | `3`, `r3 4f1c...` |
| Files | the run folder `runs/<run>/` of metareview, plus `index.html` = `report.html` | `report.html`, `run.json`, `nodes/`, `prompts/`, `raw/`, `diff.patch` |
| Title | `<owner>/<repo>#<n> review` | |
| Meta (of the newest run) | `repo`, `pr`, `run`, `headSha`, `baseSha`, `status`, `verdict`, `blocker`, `major`, `minor`, `nit`, `question` | `meta.pr=85416` |

A run is normally one per commit; a run started again on the same commit is one more version.
Branch reviews (no pull request) are not published. Share owner is `agent:metareview`.

## Publish

`POST /_blobs/missing`, `PUT /_blobs/<sha256>` for each missing blob, then
`POST /_publish/<slug>` with `{files, collection, title, message, meta}` (api-types.ts). The
response has `url` (the share; it follows the newest run) and `versionUrl` (this run only), both on
the content host. A 409 is a concurrent publish to the same share: publish again.

## Read back

- This run: `versionUrl`, `https://shares.metabase.fyi/<slug>@<version>/` (opens `index.html`, the
  report). Any file: `<slug>@<version>/<path>`. Old versions stay readable; nothing prunes them yet.
- Newest run: `https://shares.metabase.fyi/<slug>/`.
- Runs of a pull request: `GET /_api/shares/<slug>/versions` (version, message, createdAt).
- Pull requests with runs: `GET /_api/shares?collection=metareview/<owner>-<repo>/pr-<n>`, or
  `GET /_api/collections?prefix=metareview/`. Filter on meta: `&meta.verdict=blocking`.
- A browser needs a @metabase.com login. A bearer GET of `<slug>@<n>/<path>` gives the raw bytes.
