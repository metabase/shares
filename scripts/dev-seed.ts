// Seed the local dev worker (`bun run dev`) with a realistic dataset for UI
// work: several owners, every renderer, versions, collections, and older
// shares with spread-out times. Every write goes through the worker API.
// The dataset: scripts/dev-seed/fixtures.ts.
//
//   bun run dev:seed [--url http://localhost:8787]
//
// Needs SESSION_SECRET and UPLOAD_TOKEN in .dev.vars (UPLOAD_TOKEN acts as
// ADMIN_EMAIL). Each owner gets a CLI token through the device flow; the
// approve form gets a session cookie signed with SESSION_SECRET, as a
// Google login would set it. Run it again: unchanged shares are skipped,
// changed fixtures make a new version.

import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { parseLines } from '../src/api-types'
import type { Collection, ImportRequest, ImportResponse, PublishRequest, PublishResponse, ShareManifest } from '../src/api-types'
import { SESSION_DAYS, signEmail } from '../src/auth'
import type { Env } from '../src/env'
import { sha256 } from '../cli/files'
import { client, HttpError, type Client } from '../cli/http'
import { COLLECTIONS, IMPORTED, PUBLISHED, USERS, VIEWS, day, type Files, type Owner } from './dev-seed/fixtures'

const { values: args } = parseArgs({ options: { url: { type: 'string', default: 'http://localhost:8787' } } })
const base = args.url!.replace(/\/$/, '')

function devVars(): Record<string, string> {
  if (!existsSync('.dev.vars')) throw new Error('.dev.vars missing: set SESSION_SECRET and UPLOAD_TOKEN in it, then restart bun run dev')
  const out: Record<string, string> = {}
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  for (const k of ['SESSION_SECRET', 'UPLOAD_TOKEN']) if (!out[k]) throw new Error(`.dev.vars: ${k} missing`)
  return out
}

const vars = devVars()
const admin = client(base, vars.UPLOAD_TOKEN)
const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')
const bytes = (c: string | Uint8Array) => (typeof c === 'string' ? new TextEncoder().encode(c) : c) as Uint8Array<ArrayBuffer>

// the session cookie `s` of the combined host (wrangler dev)
const cookie = async (email: string) =>
  `s=${await signEmail({ SESSION_SECRET: vars.SESSION_SECRET } as Env, email, SESSION_DAYS * 86400)}`

// a user CLI token: POST /_device/code, approve as the user, poll once
async function userToken(email: string) {
  const anon = client(base)
  const start = await anon.json<{ device_code: string; user_code: string; verification_uri: string }>(
    'POST', '/_device/code', { json: { name: 'dev-seed' } })
  const approve = new URL(start.verification_uri)
  const res = await fetch(`${base}${approve.pathname}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: new URL(base).origin, cookie: await cookie(email), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'approve', code: start.user_code }),
  })
  if (res.status >= 400) throw new Error(`approve as ${email}: ${res.status} ${(await res.text()).trim()}`)
  await res.body?.cancel()
  return (await anon.json<{ token: string }>('POST', '/_device/token', { json: { device_code: start.device_code } })).token
}

async function uploadBlobs(c: Client, files: Files) {
  const list = Object.entries(files).map(([path, content]) => {
    const data = bytes(content)
    return { path, data, sha256: sha256(data) }
  })
  const missing = new Set(parseLines(await c.text('POST', '/_blobs/missing', { body: list.map((f) => f.sha256).join('\n') })))
  for (const f of list) {
    if (!missing.delete(f.sha256)) continue
    await c.text('PUT', `/_blobs/${f.sha256}`, { body: f.data })
  }
  return list.map(({ path, sha256 }) => ({ path, sha256 }))
}

const fileKey = (fs: { path: string; sha256: string }[]) => fs.map((f) => `${f.path}\0${f.sha256}`).sort().join('\n')

async function manifest(c: Client, slug: string) {
  try {
    return await c.json<ShareManifest>('GET', `/_api/shares/${enc(slug)}/manifest`)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  }
}

async function main() {
  const who = await admin.json<{ email: string; admin: boolean }>('GET', '/_api/whoami')
  if (!who.admin) throw new Error(`UPLOAD_TOKEN acts as ${who.email}, not as admin`)
  const adminEmail = who.email
  const email = (o: Owner) => (o === 'admin' ? adminEmail : o)

  const clients = new Map<string, Client>([[adminEmail, admin]])
  for (const u of USERS) clients.set(u, client(base, await userToken(u)))
  const as = (o: Owner) => clients.get(email(o))!
  console.log(`owners: ${[...clients.keys()].join(', ')} (admin ${adminEmail})`)

  const made: string[] = []
  const notes: string[] = []

  // collections first, so their owner is the spec's owner
  for (const c of COLLECTIONS) {
    await as(c.owner).json<Collection>('PUT', `/_api/collections/${enc(c.slug)}`, { json: { title: c.title, meta: c.meta ?? {} } })
  }

  // a fresh share gets every version; an existing one gets its last
  // version only when the files differ
  for (const s of PUBLISHED) {
    const c = as(s.owner)
    const cur = await manifest(c, s.slug)
    const versions = cur ? s.versions.slice(-1) : s.versions
    let last = cur?.version ?? 0
    let skipped = false
    for (const v of versions) {
      const files = await uploadBlobs(c, v.files)
      if (cur && fileKey(cur.files) === fileKey(files)) { skipped = true; break }
      const req: PublishRequest = {
        files, ...(v.message && { message: v.message }),
        ...(s.title !== undefined && { title: s.title }),
        ...(s.collection !== undefined && { collection: s.collection }),
        ...(s.meta && { meta: s.meta }),
      }
      last = (await c.json<PublishResponse>('POST', `/_publish/${enc(s.slug)}`, { json: req })).version
    }
    if (s.public) {
      const r = await c.request('POST', `/_public/${enc(s.slug)}`, { body: 'on' })
      const text = (await r.text()).trim()
      if (!r.ok) notes.push(`${s.slug} not public: ${text} (set PUBLIC_SHARING=1 in .dev.vars)`)
    }
    made.push(`${skipped ? 'same   ' : 'publish'} ${s.slug} v${last} ${email(s.owner)}${s.collection ? ` [${s.collection}]` : ''}`)
  }

  // older shares: admin imports with the owner, times and views
  const now = Date.now()
  for (const s of IMPORTED) {
    let r: ImportResponse | undefined
    for (const [i, v] of s.versions.entries()) {
      const files = await uploadBlobs(admin, v.files)
      const body: ImportRequest = {
        owner: email(s.owner), createdBy: email(s.owner),
        createdAt: now - day(s.versions[0].daysAgo), updatedAt: now - day(v.daysAgo), files,
        ...(i === s.versions.length - 1 && s.views && {
          views: Object.fromEntries(s.views.map((w) => [email(w.email), { n: w.n, last: now - day(w.daysAgo) }])),
        }),
      }
      r = await admin.json<ImportResponse>('POST', `/_import/${enc(s.slug)}`, { json: body })
    }
    made.push(`import  ${s.slug} v${r!.version} ${email(s.owner)} (${r!.result}, ${s.versions.at(-1)!.daysAgo}d ago)`)
  }

  // views through share page navigations
  let views = 0
  for (const { viewer, slugs } of VIEWS) {
    const ck = await cookie(email(viewer))
    for (const slug of slugs) {
      const res = await fetch(`${base}/${enc(slug)}/`, { headers: { cookie: ck, accept: 'text/html' } })
      await res.body?.cancel()
      if (res.ok) views++
      else notes.push(`view ${slug} as ${email(viewer)}: ${res.status}`)
    }
  }

  console.log(made.join('\n'))
  console.log(`${PUBLISHED.length + IMPORTED.length} shares, ${COLLECTIONS.length} collections, ${views} page views`)
  for (const n of notes) console.log(`note: ${n}`)
  console.log(`open ${base}/ (sign in as one of the owners above)`)
}

main().catch((e) => {
  console.error(`dev-seed: ${(e as Error).message}`)
  if (/cannot reach/.test((e as Error).message)) console.error('start the worker first: bun run dev')
  process.exit(1)
})
