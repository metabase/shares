# Move from mb-shares to shares.metabase.fyi

Moves every share of mb-shares.escherize.workers.dev (Workers KV in Bryan's account) into the D1 + R2 store of the Metabase account, keeps the slugs, and makes old links 301 to the new content host. Code: `scripts/migrate/`, `POST /_import/<slug>` (src/api/cli.ts, `importShare` in src/store/d1r2.ts), `deploy/mb-shares-cutover.patch` (for escherize/mb-shares-worker). Tests: `test/import.test.ts`, `cli/test/migrate.test.ts`.

## What moves

| Old KV key | New store |
|---|---|
| `<slug>/<path>` (metadata `t`, `o`) | blob in R2, file row of version 1; `t` gives the times, the newest `o` is the version's `created_by` |
| `_man/<slug>` | which files the share has (keys the manifest does not name are left over from `share -e` and are not imported); `t` is the share's `updated_at` |
| `_own/<slug>` | `shares.owner` (else `_man` `o`, else the newest uploader, else ADMIN_EMAIL) |
| `_views/<slug>` | `views` rows, merged with max() |
| `_pushes` | not imported: the new store counts versions per publisher |

Old CLI tokens and session cookies do not move: users run `share login` on the new host.

## Preconditions

- The TS worker serves `[env.metabase]` with `ADMIN_EMAIL` set: the import needs an admin token. `[env.metabase]` has no ADMIN_EMAIL var yet.
- An admin CLI token of the new host: `share login https://app.shares.metabase.fyi` as ADMIN_EMAIL, or a token from its `/_token` page.
- A Cloudflare API token with "Workers KV Storage: Read" on Bryan's account (Bryan runs the export, or gives this token).
- Bryan applies `deploy/mb-shares-cutover.patch` to escherize/mb-shares-worker (`git am`) and deploys it. With no var set it changes nothing.

## Steps

1. Trial: export and import while the old host is live. Every step is safe to run again.
   ```sh
   CLOUDFLARE_API_TOKEN=<kv read token> bun scripts/migrate/export.ts \
     --account <bryan account id> --namespace 8e746d88c3254e1b83b82eb02db9be0c --out export/
   bun scripts/migrate/import.ts --export export/ --dry-run      # writes export/import-plan.jsonl
   SHARES_TOKEN=<admin token> bun scripts/migrate/import.ts --export export/ --url https://app.shares.metabase.fyi
   SHARES_TOKEN=<admin token> bun scripts/migrate/verify.ts --export export/ --url https://app.shares.metabase.fyi --sample 30
   ```
   Read `export/import-report.jsonl`: shares with `error`, and `unlisted`/`missing` counts.
2. Freeze: Bryan sets `READ_ONLY = "1"` on mb-shares and deploys. Writes give 503; reads work.
3. Final export and import: export into a new dir (`--out export-final/`; a rerun into the old dir keeps the values it has, and `share -e` changed some in place), then import and verify it. Unchanged shares give `same` (views merged), changed ones `updated` (a new version). Use `export-final/` in step 5.
4. Redirect: Bryan sets `MOVED_TO = "https://shares.metabase.fyi"` and `MOVED_APP = "https://app.shares.metabase.fyi"`, removes `READ_ONLY`, deploys. Reads give 301 to the same path on the content host; writes and bearer calls give 410 with the install line of the new CLI.
5. Check links from Slack: put old links one per line in `links.txt`, then
   ```sh
   SHARES_TOKEN=<admin token> bun scripts/migrate/verify.ts --export export-final/ \
     --url https://app.shares.metabase.fyi --links links.txt --redirect https://shares.metabase.fyi
   ```
   Each link must give the export's bytes on the new host and a 301 to the same path.
6. Announce: users install the new CLI (`curl -fsSL https://app.shares.metabase.fyi/install.sh | sh`) and run `share login`, and the shares skill is updated to the new host.

Rollback before step 4: remove `READ_ONLY`. After step 4: remove `MOVED_TO`; the KV data is unchanged by the whole move.
