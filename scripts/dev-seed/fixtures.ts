// The local dev dataset of scripts/dev-seed.ts. Owner "admin" is
// ADMIN_EMAIL of the dev worker; the other owners are plain users.

import { png } from './png'

export type Content = string | Uint8Array
export type Files = Record<string, Content>

export const USERS = ['ana.lopez@metabase.com', 'sam.chen@metabase.com', 'priya.rao@metabase.com'] as const
export type Owner = 'admin' | (typeof USERS)[number]

export interface Version {
  message?: string
  files: Files
}

// published through _blobs + _publish: one version per entry, in order
export interface Published {
  slug: string
  owner: Owner
  title?: string
  collection?: string
  meta?: Record<string, string | number | boolean>
  versions: Version[]
  public?: boolean
}

// admin POST /_import: the only route that takes times. One version per
// entry, `daysAgo` sets its time.
export interface Imported {
  slug: string
  owner: Owner
  versions: { daysAgo: number; files: Files }[]
  views?: { email: Owner; n: number; daysAgo: number }[]
}

export interface CollectionSpec {
  slug: string
  owner: Owner
  title: string
  meta?: Record<string, string | number | boolean>
}

// --- content ---

const releaseNotes = (n: number) => `# Release notes: shares ${n === 1 ? 'draft' : `v0.${n}`}

Shares is the private store where people and agents publish files and get a link.

## Highlights

- Versioned publishes: each \`share\` run makes a new version[^versions].
- Collections for agent runs${n >= 2 ? '\n- Search over titles, paths and metadata' : ''}${n >= 3 ? '\n- Service tokens with collection scopes' : ''}${n >= 4 ? '\n- Public shares behind a server flag[^public]' : ''}

## Publish flow

\`\`\`mermaid
sequenceDiagram
  participant CLI as share CLI
  participant W as Worker
  participant R2
  participant D1
  CLI->>W: POST /_blobs/missing
  W->>R2: head blobs
  CLI->>W: PUT /_blobs/<sha>
  W->>R2: put
  CLI->>W: POST /_publish/<slug>
  W->>D1: one batch: version, files, index${n >= 3 ? '\n  W-->>CLI: url, versionUrl' : ''}
\`\`\`

## Limits

| What | Limit | Since |
|---|---:|---|
| file size | ${n >= 3 ? '100 MB' : '25 MB'} | v0.1 |
| files per share | 10000 | v0.1 |
| versions kept | ${n >= 4 ? '50' : 'all'} | v0.${n >= 4 ? 4 : 1} |

## Example

\`\`\`ts
const res = await fetch(\`\${base}/_publish/\${slug}\`, {
  method: 'POST',
  headers: { authorization: \`Bearer \${token}\` },
  body: JSON.stringify({ files, title: 'Release notes' }),
})
console.log((await res.json()).url)
\`\`\`
${n >= 2 ? '\n## Known issues\n\n- Hover previews do not render mermaid.\n' : ''}
[^versions]: Older versions stay readable at \`<slug>@<n>/\`.
${n >= 4 ? '[^public]: Off by default; set `PUBLIC_SHARING=1`.\n' : ''}`

const csvRows = (n: number) => {
  const regions = ['us-east', 'us-west', 'eu-central', 'ap-south']
  const rows = ['date,region,signups,churned,mrr_usd']
  for (let d = 0; d < n; d++) {
    const date = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10)
    for (const [i, r] of regions.entries()) {
      rows.push(`${date},${r},${20 + ((d * 7 + i * 13) % 31)},${(d + i) % 5},${(41000 + d * 120 + i * 900).toFixed(2)}`)
    }
  }
  return rows.join('\n') + '\n'
}

const pyEtl = (v: number) => `"""Nightly export of share stats to the warehouse."""

import json
import sys
from datetime import date${v >= 2 ? ', timedelta' : ''}


def load(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def summarize(rows):
    out = {}
    for r in rows:
        out.setdefault(r["owner"], 0)
        out[r["owner"]] += r["views"]
    return out
${v >= 2 ? `

def window(rows, days=7):
    start = date.today() - timedelta(days=days)
    return [r for r in rows if date.fromisoformat(r["day"]) >= start]
` : ''}

if __name__ == "__main__":
    rows = load(sys.argv[1])
    print(json.dumps(summarize(${v >= 2 ? 'window(rows)' : 'rows'}), indent=2))
`

const sqlQuery = `-- weekly active publishers
SELECT date_trunc('week', v.created_at) AS week,
       count(DISTINCT v.created_by)     AS publishers,
       count(*)                         AS versions
FROM versions v
WHERE v.state = 'complete'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 12;
`

const goSnippet = `package main

import (
\t"fmt"
\t"net/http"
)

func main() {
\thttp.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
\t\tfmt.Fprintln(w, "ok")
\t})
\thttp.ListenAndServe(":8080", nil)
}
`

const dashboardHtml = (v: number) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Signups dashboard</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<h1>Signups by region${v >= 2 ? ' <small>(last 30 days)</small>' : ''}</h1>
<p>Static page with its own CSS, script and data file.</p>
<table id="t"><thead><tr><th>region</th><th>signups</th></tr></thead><tbody></tbody></table>
<p><a href="notes/method.html">How the numbers are made</a></p>
<script src="app.js"></script>
</body>
</html>
`

const dashboardJs = `fetch('data/signups.json').then((r) => r.json()).then((rows) => {
  const body = document.querySelector('#t tbody')
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td>' + r.region + '</td><td>' + r.signups + '</td>'
    body.appendChild(tr)
  }
})
`

const dashboardCss = `body { font: 15px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid #ddd; padding: .3rem .5rem; text-align: left; }
`

const svgChart = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">
  <rect width="320" height="160" fill="#f6f8fa"/>
  <polyline fill="none" stroke="#509ee3" stroke-width="3"
    points="10,140 50,120 90,125 130,90 170,95 210,60 250,70 290,30"/>
  <text x="10" y="20" font-family="sans-serif" font-size="14" fill="#333">weekly publishes</text>
</svg>
`

const gradient = png(160, 96, (x, y) => [80 + Math.round((x / 159) * 120), 158 - Math.round((y / 95) * 60), 227])

const findings = (pr: number, n: number) => JSON.stringify({
  pr, repo: 'metabase/metabase', model: 'claude-opus-5-5',
  findings: Array.from({ length: n }, (_, i) => ({
    id: `F${i + 1}`,
    file: ['src/metabase/api/card.clj', 'frontend/src/metabase/query_builder/actions.ts', 'src/metabase/sync/core.clj'][i % 3],
    line: 40 + i * 17,
    severity: ['high', 'medium', 'low'][i % 3],
    summary: [
      'Permission check runs after the query, so a 403 still costs a full run',
      'Debounced save drops the last edit when the tab closes',
      'Sync retries forever on a revoked connection',
      'N+1 query when loading dashboard cards',
    ][i % 4],
  })),
}, null, 2)

const reviewMd = (pr: number, title: string, verdict: string) => `# Review of PR #${pr}: ${title}

**Verdict:** ${verdict}

## Summary

The change is small and the tests cover the main path. Two findings need a fix before merge; see \`findings.json\`.

## Checklist

- [x] Tests pass
- [x] No new public API
- [ ] Docs updated
`

const meetingNotes = (topic: string, i: number) => `# ${topic}

Attendees: Ana, Sam, Priya

## Notes

${i % 2 ? '- Agreed to ship behind a flag.\n- Follow-up on metrics next week.' : '- Open question on retention policy.\n- Sam to draft the migration plan.'}

## Actions

1. Write the decision doc
2. Share it in #shares
`

const config = (env: string) => JSON.stringify({ env, region: 'us-east-1', replicas: env === 'prod' ? 3 : 1, features: { search: true, public: false } }, null, 2)

// --- the dataset ---

export const COLLECTIONS: CollectionSpec[] = [
  { slug: 'metareview/pr-1', owner: 'priya.rao@metabase.com', title: 'metareview: PR 48211', meta: { repo: 'metabase/metabase', pr: 48211 } },
  { slug: 'metareview/pr-2', owner: 'priya.rao@metabase.com', title: 'metareview: PR 48307', meta: { repo: 'metabase/metabase', pr: 48307 } },
  { slug: 'design/reviews', owner: 'ana.lopez@metabase.com', title: 'Design reviews' },
  { slug: 'analytics', owner: 'sam.chen@metabase.com', title: 'Analytics exports' },
]

export const PUBLISHED: Published[] = [
  {
    slug: 'release-notes', owner: 'admin', title: 'Shares release notes', meta: { kind: 'notes' },
    versions: [1, 2, 3, 4].map((n) => ({
      message: ['first draft', 'add search', 'service tokens, bigger files', 'public shares, version limit'][n - 1],
      files: { 'release-notes.md': releaseNotes(n) },
    })),
  },
  {
    slug: 'signups-dashboard', owner: 'sam.chen@metabase.com', title: 'Signups dashboard', collection: 'analytics',
    versions: [1, 2, 3].map((v) => ({
      message: ['first cut', 'last 30 days', 'method notes'][v - 1],
      files: {
        'index.html': dashboardHtml(v),
        'style.css': dashboardCss,
        'app.js': dashboardJs,
        'data/signups.json': JSON.stringify(['us-east', 'us-west', 'eu-central'].map((region, i) => ({ region, signups: 100 * (i + 1) + v * 7 }))),
        ...(v >= 3 ? { 'notes/method.html': '<!doctype html><title>Method</title><p>Signups count accounts with a verified email.</p>' } : {}),
      },
    })),
  },
  {
    slug: 'etl-export', owner: 'sam.chen@metabase.com', title: 'Stats export script', collection: 'analytics', meta: { lang: 'python' },
    versions: [1, 2, 3].map((v) => ({
      message: ['initial', 'add 7 day window', 'add sample input'][v - 1],
      files: { 'export.py': pyEtl(Math.min(v, 2)), ...(v >= 3 ? { 'sample.jsonl': '{"owner":"ana","views":3,"day":"2026-10-20"}\n{"owner":"sam","views":5,"day":"2026-10-21"}\n' } : {}) },
    })),
  },
  {
    slug: 'regional-metrics', owner: 'sam.chen@metabase.com', title: 'Regional metrics, September', collection: 'analytics',
    versions: [{ files: { 'metrics.csv': csvRows(30) } }],
  },
  {
    slug: 'weekly-publishers-sql', owner: 'sam.chen@metabase.com', title: 'Weekly publishers query',
    versions: [{ files: { 'weekly.sql': sqlQuery } }],
  },
  {
    slug: 'healthz-go', owner: 'ana.lopez@metabase.com', title: 'Go healthz handler',
    versions: [{ files: { 'main.go': goSnippet } }],
  },
  {
    slug: 'brand-gradient', owner: 'ana.lopez@metabase.com', title: 'Gradient swatch', collection: 'design/reviews',
    versions: [{ files: { 'gradient.png': gradient } }],
  },
  {
    slug: 'publish-chart', owner: 'ana.lopez@metabase.com', title: 'Publishes chart (SVG)', collection: 'design/reviews',
    versions: [{ files: { 'chart.svg': svgChart } }],
  },
  {
    slug: 'onboarding-flow', owner: 'ana.lopez@metabase.com', title: 'Onboarding flow review', collection: 'design/reviews',
    meta: { status: 'in-review' },
    versions: [1, 2, 3].map((v) => ({
      message: ['first pass', 'feedback from Sam', 'final'][v - 1],
      files: {
        'index.md': `# Onboarding flow\n\nRound ${v} of the review.\n\n- [Screens](screens.md)\n- [Copy](copy.md)\n\n![gradient](swatch.png)\n`,
        'screens.md': `# Screens\n\n| Step | Screen | Status |\n|---|---|---|\n| 1 | Welcome | done |\n| 2 | Connect data | ${v >= 2 ? 'done' : 'todo'} |\n| 3 | First question | ${v >= 3 ? 'done' : 'todo'} |\n`,
        'copy.md': `# Copy\n\n> ${v >= 2 ? 'Connect your data in two minutes.' : 'Connect your database.'}\n`,
        'swatch.png': gradient,
      },
    })),
  },
  {
    slug: 'deploy-config', owner: 'admin', title: 'Deploy config',
    versions: [{ message: 'staging', files: { 'staging.json': config('staging') } },
      { message: 'add prod', files: { 'staging.json': config('staging'), 'prod.json': config('prod') } }],
  },
  {
    slug: 'public-faq', owner: 'admin', title: 'Shares FAQ (public)', public: true,
    versions: [{ files: { 'faq.md': '# Shares FAQ\n\n## Who can open a share?\n\nAnyone with a @metabase.com account. Public shares open without login.\n\n## How do I delete one?\n\n`share rm <slug>`\n' } }],
  },
  {
    slug: 'mr-48211-review', owner: 'priya.rao@metabase.com', title: 'Review: cache dashboard card results', collection: 'metareview/pr-1',
    meta: { pr: 48211, run: 1, verdict: 'changes-requested' },
    versions: [{ message: 'run 1', files: { 'review.md': reviewMd(48211, 'cache dashboard card results', 'changes requested'), 'findings.json': findings(48211, 4) } },
      { message: 'run 2 after fixes', files: { 'review.md': reviewMd(48211, 'cache dashboard card results', 'approve'), 'findings.json': findings(48211, 1) } }],
  },
  {
    slug: 'mr-48211-perf', owner: 'priya.rao@metabase.com', title: 'Perf check: PR 48211', collection: 'metareview/pr-1',
    meta: { pr: 48211, kind: 'perf' },
    versions: [{ files: { 'timings.csv': 'case,before_ms,after_ms\ndashboard 12 cards,840,310\ndashboard 40 cards,2900,760\nsingle card,120,118\n' } }],
  },
  {
    slug: 'mr-48307-review', owner: 'priya.rao@metabase.com', title: 'Review: sync retry backoff', collection: 'metareview/pr-2',
    meta: { pr: 48307, run: 1, verdict: 'approve' },
    versions: [{ files: { 'review.md': reviewMd(48307, 'sync retry backoff', 'approve'), 'findings.json': findings(48307, 2) } }],
  },
  {
    slug: 'mr-48307-logs', owner: 'priya.rao@metabase.com', title: 'Agent log: PR 48307', collection: 'metareview/pr-2',
    meta: { pr: 48307, kind: 'log' },
    versions: [{ files: { 'run.log': Array.from({ length: 40 }, (_, i) => `2026-10-29T14:${String(i).padStart(2, '0')}:00Z step ${i}: ${i % 7 ? 'ok' : 'retry'}`).join('\n') + '\n' } }],
  },
  {
    slug: 'retro-notes', owner: 'priya.rao@metabase.com', title: 'Q3 retro notes',
    versions: [1, 2, 3].map((v) => ({
      message: ['notes', 'actions', 'owners'][v - 1],
      files: { 'retro.md': `# Q3 retro\n\n## Went well\n\n- Port to the Metabase account\n- Collections\n${v >= 2 ? '\n## Actions\n\n1. Seed data for local dev\n2. Reset command\n' : ''}${v >= 3 ? '\n## Owners\n\n| Action | Owner |\n|---|---|\n| Seed data | Tyler |\n| Reset | Sam |\n' : ''}` },
    })),
  },
  {
    slug: 'api-schema', owner: 'admin', title: 'API response samples', meta: { kind: 'reference' },
    versions: [{ files: {
      'whoami.json': JSON.stringify({ kind: 'user', email: 'ana.lopez@metabase.com', admin: false, token: 'a1b2c3d4e5f6' }),
      'shares.json': JSON.stringify([{ slug: 'release-notes', title: 'Shares release notes', version: 4 }]),
      'README.md': '# API samples\n\nOne JSON file per endpoint.\n',
    } }],
  },
  {
    slug: 'design-tokens', owner: 'ana.lopez@metabase.com', title: 'Design tokens', collection: 'design/reviews',
    versions: [{ files: { 'tokens.css': ':root {\n  --brand: #509ee3;\n  --fg: #2e353b;\n  --bg: #ffffff;\n}\n', 'tokens.json': JSON.stringify({ brand: '#509ee3', fg: '#2e353b', bg: '#ffffff' }, null, 2) } }],
  },
  {
    slug: 'shell-helpers', owner: 'sam.chen@metabase.com',
    versions: [{ files: { 'helpers.sh': '#!/bin/sh\n# print the newest share of mine\nshare ls | head -1\n' } }],
  },
  {
    slug: 'incident-2026-10-12', owner: 'admin', title: 'Incident: R2 latency spike',
    versions: [{ message: 'timeline', files: { 'incident.md': '# Incident 2026-10-12\n\n## Timeline\n\n| Time (UTC) | Event |\n|---|---|\n| 14:02 | p99 over 2s |\n| 14:20 | rollback |\n' } },
      { message: 'root cause', files: { 'incident.md': '# Incident 2026-10-12\n\n## Timeline\n\n| Time (UTC) | Event |\n|---|---|\n| 14:02 | p99 over 2s |\n| 14:20 | rollback |\n| 14:31 | recovered |\n\n## Root cause\n\nA blob head per file on large shares[^1].\n\n[^1]: Fixed by a batch head.\n' } }],
  },
]

const DAY = 86400_000
export const day = (n: number) => n * DAY

const legacy: [string, Owner, number, string, Content][] = [
  ['old-roadmap-x7k2p1', 'admin', 118, 'roadmap.md', '# Roadmap 2026\n\n- Q1: port\n- Q2: collections\n- Q3: web UI\n'],
  ['standup-0901-a1b2c3', 'ana.lopez@metabase.com', 59, 'standup.md', meetingNotes('Standup 09-01', 1)],
  ['standup-0908-d4e5f6', 'ana.lopez@metabase.com', 52, 'standup.md', meetingNotes('Standup 09-08', 2)],
  ['standup-0915-g7h8i9', 'ana.lopez@metabase.com', 45, 'standup.md', meetingNotes('Standup 09-15', 3)],
  ['query-results-q2', 'sam.chen@metabase.com', 90, 'results.csv', csvRows(5)],
  ['churn-model-notes', 'sam.chen@metabase.com', 74, 'notes.md', '# Churn model\n\nLogistic regression on 12 features. AUC 0.81.\n'],
  ['perf-trace-8812', 'priya.rao@metabase.com', 33, 'trace.json', JSON.stringify({ spans: [{ name: 'query', ms: 812 }, { name: 'render', ms: 140 }] })],
  ['offsite-agenda', 'priya.rao@metabase.com', 21, 'agenda.md', meetingNotes('Offsite agenda', 4)],
  ['logo-draft', 'ana.lopez@metabase.com', 14, 'logo.svg', svgChart],
  ['migration-plan-v1', 'admin', 9, 'plan.md', '# KV to D1 migration\n\n1. Export\n2. Import\n3. Verify\n'],
  ['hiring-loop', 'priya.rao@metabase.com', 6, 'loop.md', meetingNotes('Hiring loop', 5)],
  ['bench-results', 'sam.chen@metabase.com', 3, 'bench.csv', 'case,ms\ncold,410\nwarm,38\n'],
  ['scratch-snippet', 'ana.lopez@metabase.com', 1, 'snippet.ts', 'export const add = (a: number, b: number) => a + b\n'],
]

export const IMPORTED: Imported[] = [
  ...legacy.map(([slug, owner, daysAgo, path, content], i) => ({
    slug, owner, versions: [{ daysAgo, files: { [path]: content } }],
    views: i % 3 ? [] : [{ email: 'admin' as Owner, n: 2 + i, daysAgo: Math.max(0, daysAgo - 2) },
      { email: 'sam.chen@metabase.com' as Owner, n: 1, daysAgo: Math.max(0, daysAgo - 1) }],
  })),
  {
    slug: 'oncall-handbook', owner: 'sam.chen@metabase.com',
    versions: [
      { daysAgo: 80, files: { 'handbook.md': '# On-call handbook\n\n## Pager\n\nAck in 5 minutes.\n' } },
      { daysAgo: 40, files: { 'handbook.md': '# On-call handbook\n\n## Pager\n\nAck in 5 minutes.\n\n## Escalation\n\nPage the secondary after 15 minutes.\n' } },
      { daysAgo: 12, files: { 'handbook.md': '# On-call handbook\n\n## Pager\n\nAck in 10 minutes.\n\n## Escalation\n\nPage the secondary after 15 minutes.\n\n## Runbooks\n\n- R2 latency\n- D1 errors\n' } },
    ],
    views: [{ email: 'ana.lopez@metabase.com', n: 9, daysAgo: 2 }, { email: 'priya.rao@metabase.com', n: 4, daysAgo: 5 }],
  },
]

// share page GETs after the seed, as these viewers: real view rows
export const VIEWS: { viewer: Owner; slugs: string[] }[] = [
  { viewer: 'admin', slugs: ['signups-dashboard', 'mr-48211-review', 'retro-notes'] },
  { viewer: 'ana.lopez@metabase.com', slugs: ['release-notes', 'regional-metrics', 'mr-48307-review'] },
  { viewer: 'sam.chen@metabase.com', slugs: ['release-notes', 'onboarding-flow'] },
  { viewer: 'priya.rao@metabase.com', slugs: ['release-notes', 'signups-dashboard', 'incident-2026-10-12'] },
]
