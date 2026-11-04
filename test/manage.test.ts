import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { sha256Hex } from '../src/store/d1r2'
import { lineDiff, hunks } from '../src/web/diff'
import { ADMIN, ORIGIN, api, browse, fetchWorker, sessionCookie, slug, userToken } from './helpers'

const OWNER = 'owner@metabase.com'
const OTHER = 'other@metabase.com'

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

async function commit(top: string, files: Record<string, string>, token: string, attrs: object = {}) {
  const entries = await Promise.all(Object.entries(files).map(async ([path, body]) => ({ path, body, sha256: await sha(body) })))
  for (const e of entries) await api('PUT', `/_blobs/${e.sha256}`, { token, body: e.body })
  const r = await api('POST', `/_publish/${top}`, {
    token, body: JSON.stringify({ files: entries.map(({ path, sha256 }) => ({ path, sha256 })), ...attrs }),
  })
  expect(r.status).toBe(200)
}

// a form submit of the share page, as a browser sends it
const submit = (top: string, fields: Record<string, string>, email = OWNER, headers: Record<string, string> = {}) =>
  formAt(`/_s/${top}`, fields, email, headers)

async function formAt(path: string, fields: Record<string, string>, email = OWNER, headers: Record<string, string> = {}) {
  return fetchWorker(path, {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: {
      cookie: await sessionCookie(email),
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      ...headers,
    },
  })
}

const text = async (path: string, email = OWNER) => {
  const r = await browse(path, email)
  return { status: r.status, body: await r.text() }
}

describe('line diff', () => {
  it('marks added and removed lines and keeps context around them', () => {
    const ops = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne')!
    expect(ops.map((o) => o.t + o.s)).toEqual([' a', '-b', '+B', ' c', ' d', '+e'])
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const b = [...a]
    b[10] = 'x'
    const h = hunks(lineDiff(a.join('\n'), b.join('\n'))!, 2)
    expect(h[0]).toBeNull()
    expect(h.filter((o) => o?.t === '+').map((o) => o!.s)).toEqual(['x'])
    expect(h.filter(Boolean)).toHaveLength(6)
  })

  it('has no hunks for equal texts', () => {
    expect(hunks(lineDiff('a\nb', 'a\nb')!)).toEqual([])
  })

  it('gives an added file only added lines', () => {
    expect(lineDiff('', 'x\ny\n')!.map((o) => o.t + o.s)).toEqual(['+x', '+y'])
  })
})

describe('app nav', () => {
  it('marks the current page and shows Activity to the admin only', async () => {
    const member = (await text('/_collections', OTHER)).body
    expect(member).toContain('<a href="/_collections" class="on" aria-current="page">Collections</a>')
    expect(member).toContain('<a href="/_token">Install</a>')
    expect(member).not.toContain('Activity')
    expect(member).toContain('<select data-thm')
    const admin = (await text('/_stats', ADMIN)).body
    expect(admin).toContain('<a href="/_stats" class="on" aria-current="page">Activity</a>')
    expect(admin).toContain('<a href="/">Shares</a>')
  })

  it('titles the list "My shares" for a member and gives the admin a Mine / Everyone toggle that keeps the search', async () => {
    const member = (await text('/', OTHER)).body
    expect(member).toContain('<h1>My shares</h1>')
    expect(member).not.toContain('class="scope"')
    const every = (await text('/?q=zebra', ADMIN)).body
    expect(every).toContain('<a href="/?mine&q=zebra">Mine</a><a href="/?q=zebra" class="on" aria-current="true">Everyone</a>')
    const mine = (await text('/?mine', ADMIN)).body
    expect(mine).toContain('<h1>My shares</h1>')
    expect(mine).toContain('<a href="/?mine" class="on" aria-current="true">Mine</a><a href="/">Everyone</a>')
  })
})

describe('web app', () => {
  it('finds a share by a word of a file path, title or metadata, only among your own', async () => {
    const t = await userToken(OWNER)
    const top = slug('find')
    await commit(top, { 'reports/quarterly-zebra.md': '# z' }, t, { title: 'Ocelot summary', meta: { ticket: 'wombat-77' } })
    for (const q of ['zebra', 'ocelot', 'wombat', 'quart']) {
      expect((await text(`/?q=${q}`)).body, q).toContain(`/_s/${top}`)
    }
    expect((await text('/?q=zebra', OTHER)).body).not.toContain(top)
    expect((await text('/?q=zebra', ADMIN)).body).toContain(top)
  })

  it('lists the shares of a collection and the collections', async () => {
    const t = await userToken(OWNER)
    const col = `team/${slug('col')}`
    const top = slug('incol')
    await commit(top, { 'a.md': 'a' }, t, { collection: col })
    expect((await text(`/?c=${encodeURIComponent(col)}`, OTHER)).body).toContain(top)
    const cols = await text('/_collections', OTHER)
    expect(cols.status).toBe(200)
    expect(cols.body).toContain(`/?c=${encodeURIComponent(col)}`)
  })

  it('shows versions, the files of an old version as escaped text, and a diff', async () => {
    const t = await userToken(OWNER)
    const top = slug('ver')
    await commit(top, { 'a.md': 'one\ntwo\n<script>x</script>\n', 'gone.txt': 'g' }, t)
    await commit(top, { 'a.md': 'one\nTWO\n<script>x</script>\n', 'new.txt': 'n' }, t, { message: 'second' })

    const p = await text(`/_s/${top}`)
    expect(p.status).toBe(200)
    expect(p.body).toContain('second')
    expect(p.body).toContain(`?diff=1..2`)

    const v1 = await text(`/_s/${top}?v=1&f=a.md`)
    expect(v1.body).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(v1.body).not.toContain('<script>x</script>')
    expect(v1.body).toContain('gone.txt')

    const d = (await text(`/_s/${top}?diff=1..2`)).body
    expect(d).toContain('3 of 3 files differ')
    expect(d).toContain('<span class="d-del">- two</span>')
    expect(d).toContain('<span class="d-add">+ TWO</span>')
    expect(d).toMatch(/gone\.txt<\/b> <span class="tag">removed/)
    expect(d).toMatch(/new\.txt<\/b> <span class="tag">added/)
  })

  it('gives the list rows and the share page header icon buttons with a label, one toast and the link favicon', async () => {
    const t = await userToken(OWNER)
    const top = slug('ic')
    await commit(top, { 'a.md': 'a' }, t)
    const list = (await text('/')).body
    expect(list).toMatch(new RegExp(`class="ic cp" data-u="[^"]*/${top}/" aria-label="Copy link" title="Copy link"><svg`))
    expect(list).toContain(`href="/_s/${top}" aria-label="Settings" title="Settings"><svg`)
    expect(list.match(/id="toast" role="status" aria-live="polite"/g)).toHaveLength(1)
    expect(list).toContain('<link rel="icon" href="data:image/svg+xml,')
    expect(list).toContain(encodeURIComponent('🔗'))
    const sh = (await text(`/_s/${top}`)).body
    expect(sh).toContain('aria-label="Copy link"')
    expect(sh).toMatch(/href="[^"]*_zip" aria-label="Download zip" title="Download zip"><svg/)
    expect(sh).toMatch(/class="btn pri" href="[^"]*">Open<\/a>/)
  })

  it('shows the manage forms and views to the owner only', async () => {
    const t = await userToken(OWNER)
    const top = slug('mg')
    await commit(top, { 'a.md': 'a' }, t)
    expect((await text(`/_s/${top}`)).body).toContain('name="action" value="delete"')
    const other = await text(`/_s/${top}`, OTHER)
    expect(other.status).toBe(200)
    expect(other.body).not.toContain('value="delete"')
    expect(other.body).not.toContain('<h2>Views</h2>')
  })

  it('deletes a share after the slug is typed, with an audit row', async () => {
    const t = await userToken(OWNER)
    const top = slug('del')
    await commit(top, { 'a.md': 'a' }, t)
    expect((await submit(top, { action: 'delete', confirm: 'nope' })).status).toBe(400)
    expect((await submit(top, { action: 'delete', confirm: top }, OTHER)).status).toBe(403)
    const r = await submit(top, { action: 'delete', confirm: top })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/')
    expect((await text(`/_s/${top}`)).status).toBe(404)
    expect((await text(`/?q=${top}`)).body).not.toContain(`/_s/${top}`)
    expect((await api('GET', '/_audit')).ok && await (await api('GET', '/_audit')).text()).toContain(`share.delete\t${top}`)
  })

  it('refuses a form post from another origin or from a fetch()', async () => {
    const t = await userToken(OWNER)
    const top = slug('csrf')
    await commit(top, { 'a.md': 'a' }, t)
    expect((await submit(top, { action: 'delete', confirm: top }, OWNER, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await submit(top, { action: 'delete', confirm: top }, OWNER, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(403)
    expect((await text(`/_s/${top}`)).status).toBe(200)
  })

  it('renames a share with all its versions, and refuses a taken slug', async () => {
    const t = await userToken(OWNER)
    const top = slug('ren')
    const to = slug('renamed')
    const taken = slug('taken')
    await commit(top, { 'a.md': 'v1' }, t, { title: 'Keep me', meta: { k: 'v' } })
    await commit(top, { 'a.md': 'v2' }, t)
    await commit(taken, { 'a.md': 'x' }, t)
    expect((await submit(top, { action: 'rename', to: taken })).status).toBe(409)
    expect((await submit(top, { action: 'rename', to: '_bad' })).status).toBe(400)

    const r = await submit(top, { action: 'rename', to })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe(`/_s/${to}`)
    const info = await (await api('GET', `/_api/shares/${to}`, { token: t })).json() as any
    expect(info).toMatchObject({ slug: to, title: 'Keep me', meta: { k: 'v' }, version: 2, owner: OWNER })
    const vs = await (await api('GET', `/_api/shares/${to}/versions`, { token: t })).json() as any[]
    expect(vs.map((v) => v.version)).toEqual([2, 1])
    expect(await (await api('GET', `/${to}/a.md`, { token: t })).text()).toBe('v2')
    expect((await api('GET', `/_api/shares/${top}`, { token: t })).status).toBe(404)
    expect((await text('/?q=renamed')).body).toContain(`/_s/${to}`)
  })

  it('transfers a share to another @domain owner', async () => {
    const t = await userToken(OWNER)
    const top = slug('xfer')
    await commit(top, { 'a.md': 'a' }, t)
    expect((await submit(top, { action: 'transfer', to: 'someone@example.com' })).status).toBe(400)
    expect((await submit(top, { action: 'transfer', to: OTHER })).status).toBe(303)
    const info = await (await api('GET', `/_api/shares/${top}`, { token: t })).json() as any
    expect(info.owner).toBe(OTHER)
    expect((await submit(top, { action: 'delete', confirm: top })).status).toBe(403)
    expect((await text('/?q=xfer', OTHER)).body).toContain(`/_s/${top}`)
  })

  it('sets the title on its own form, and an empty title clears it', async () => {
    const t = await userToken(OWNER)
    const top = slug('attr')
    await commit(top, { 'a.md': 'a' }, t, { collection: 'notes/x' })
    expect((await submit(top, { action: 'title', title: 'Narwhal notes' })).status).toBe(303)
    let info = await (await api('GET', `/_api/shares/${top}`, { token: t })).json() as any
    expect(info).toMatchObject({ title: 'Narwhal notes', collection: 'notes/x' })
    expect((await text('/?q=narwhal')).body).toContain(`/_s/${top}`)
    await submit(top, { action: 'title', title: '' })
    info = await (await api('GET', `/_api/shares/${top}`, { token: t })).json() as any
    expect(info).toMatchObject({ title: null, collection: 'notes/x' })
  })

  it('moves a share to a collection of another owner, to a new path, and out of its collection', async () => {
    const t = await userToken(OWNER)
    const top = slug('mv')
    await commit(top, { 'a.md': 'a' }, t)
    await commit(slug('mvo'), { 'a.md': 'a' }, await userToken(OTHER), { collection: 'theirs/x' })
    const get = async () => (await (await api('GET', `/_api/shares/${top}`, { token: t })).json() as any).collection

    const r = await submit(top, { action: 'move', collection: 'theirs/x', new: '' })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe(`/_s/${top}?moved`)
    expect(await get()).toBe('theirs/x')
    expect((await (await api('GET', '/_api/collections/theirs/x', { token: t })).json() as any).owner).toBe(OTHER)

    expect((await submit(top, { action: 'move', collection: 'theirs/x', new: '/Mine/New/' })).status).toBe(303)
    expect(await get()).toBe('mine/new')
    expect((await (await api('GET', '/_api/collections/mine/new', { token: t })).json() as any).owner).toBe(OWNER)

    expect((await submit(top, { action: 'move', new: 'a/b/c/d/e' })).status).toBe(400)
    expect((await submit(top, { action: 'move', collection: 'theirs/x' }, OTHER)).status).toBe(403)
    expect(await get()).toBe('mine/new')

    await submit(top, { action: 'move', collection: '' })
    expect(await get()).toBe(null)
  })

  it('shows the collection as a chip with a picker and a no-JS form, and a notice after a move', async () => {
    const t = await userToken(OWNER)
    const top = slug('pk')
    await commit(top, { 'a.md': 'a' }, t, { collection: 'pick/here' })
    await commit(slug('pk2'), { 'a.md': 'a' }, t, { collection: 'pick/there' })
    expect((await api('PUT', '/_api/collections/pick/there', { token: t, body: JSON.stringify({ title: 'There <b>' }) })).status).toBe(200)
    const own = (await text(`/_s/${top}`)).body
    expect(own).toContain('<span class="chip">pick/here</span>')
    expect(own).toContain('<button type="button" class="mvb" aria-haspopup="dialog">Move</button>')
    expect(own).toMatch(/<dialog class="pick"[^>]*>\s*<form method="post" action="[^"]+"><input type="hidden" name="action" value="move">/)
    expect(own).toMatch(/role="option" name="collection" value="pick\/here" disabled[^>]*>[^]*?<span class="tag">current<\/span>/)
    expect(own).toMatch(/value="pick\/there"\n data-k="pick\/there there &lt;b&gt;"><span class="p">pick\/there<\/span><span class="t">There &lt;b&gt;<\/span><span class="n">1 share<\/span>/)
    expect(own).toContain('<option value="pick/here" selected>pick/here</option>')
    expect(own).toContain('<label>Or a new path<input name="new"')
    expect(own).not.toContain('Moved to')
    const moved = (await text(`/_s/${top}?moved`)).body
    expect(moved).toContain('<noscript><p class="moved" role="status">Moved to pick/here</p></noscript>')
    expect(moved).toContain('appToast("Moved to pick/here", 3000)')
    expect((await text(`/_s/${top}`, OTHER)).body).not.toContain('class="pick"')
  })

  it('shows the slug under its collection, and the edit-access hint to the owner only', async () => {
    const t = await userToken(OWNER)
    const top = slug('head')
    await commit(top, { 'a.md': 'a' }, t, { collection: 'notes/y' })
    const own = (await text(`/_s/${top}`)).body
    expect(own).toContain(`<p class="slugline"><a href="/?c=notes%2Fy">notes/y</a> / ${top}</p>`)
    expect(own).toContain('You lose edit access.')
    expect(own).toMatch(/<p class="dzh">Delete share<\/p>\s*<form method="post" action="[^"]+" class="dz">/)
    expect((await text(`/_s/${top}`, ADMIN)).body).not.toContain('You lose edit access.')
  })

  it('shows the audit log on the stats page to the admin', async () => {
    const t = await userToken(OWNER)
    const top = slug('aud')
    await commit(top, { 'a.md': 'a' }, t)
    await submit(top, { action: 'transfer', to: OTHER })
    const s = await text('/_stats', ADMIN)
    expect(s.body).toContain('share.transfer')
    expect((await text('/_stats', OWNER)).status).toBe(403)
  })

  it('lets the admin create, list and revoke service tokens on the token page', async () => {
    const name = slug('bot').toLowerCase()
    expect((await formAt('/_token', { action: 'service-create', name, scopes: 'write:x/*' }, OWNER)).status).toBe(403)
    expect((await text('/_token', OWNER)).body).not.toContain('Service tokens')
    const bad = await formAt('/_token', { action: 'service-create', name, scopes: 'nope' }, ADMIN)
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('bad scopes')

    const r = await formAt('/_token', { action: 'service-create', name, scopes: 'write:bots/* read:other', on_behalf_of: OWNER }, ADMIN)
    expect(r.status).toBe(200)
    const token = (await r.text()).match(/shr_[0-9a-f]{12}_[0-9a-f]{64}/)![0]
    const list = await (await api('GET', '/_api/tokens?kind=service')).json() as any[]
    const row = list.find((t) => t.name === name)
    expect(row).toMatchObject({ scopes: ['write:bots/*', 'read:other'], on_behalf_of: OWNER })
    expect((await api('GET', '/_api/shares?collection=bots/a', { token })).status).toBe(200)
    expect((await text('/_token', ADMIN)).body).toContain(`agent:${name}`)

    expect((await formAt('/_token', { action: 'service-revoke', id: row.id }, ADMIN)).status).toBe(303)
    expect((await api('GET', '/_api/shares?collection=bots/a', { token })).status).toBe(401)
  })

  it('serves the pages on the app host and sends them there from the content host', async () => {
    const r = await fetchWorker('/_collections', {}, `https://${env.CONTENT_HOST}`)
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(`https://${env.APP_HOST}/_collections`)
  })
})
