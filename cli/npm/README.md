# @metabase/shares

The `share` CLI: publish a file or directory to Metabase shares and get a link
that only signed-in @metabase.com accounts can open.

```sh
npm i -g @metabase/shares
share login
share report.md
```

`share -h` lists every command. Standalone binaries (no Node needed):
`curl -fsSL https://app.shares.metabase.fyi/install.sh | sh`.
