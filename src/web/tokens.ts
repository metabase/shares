// Token pages and the device flow endpoints. The pages need a session
// (/_token: list, create, revoke; the approve page of `share login`); the
// device endpoints need nothing: the device code is the credential.

import type { Env } from '../env'
import type { DeviceStartResponse, DeviceTokenResponse, TokenInfo } from '../api-types'
import { esc, page } from '../render/page'
import { STYLE as APP_STYLE, codeBlock, nav, when } from './shell'
import { appBase, contentBase, hostKind } from '../origins'
import {
  DEVICE_SECONDS, POLL_SECONDS, createServiceToken, createToken, decideDevice, deviceByUserCode, formatUserCode,
  listServiceTokens, listTokens, pollDevice, revokeServiceToken, revokeToken, startDevice, type TokenRow,
} from '../tokens'
import { serviceSpec } from '../api/tokens'

// The approve page: /cli on the app host. On the combined host /cli is a
// share slug, so the page is at /_device there.
export const approvePath = (url: URL, env: Env) => hostKind(url, env) === 'app' ? '/cli' : '/_device'

const origins = (url: URL, env: Env) => ({
  app: appBase(url, env) || url.origin,
  content: contentBase(url, env) || url.origin,
})

// POST /_device/code and POST /_device/token. null: not a device endpoint.
export async function deviceApi(req: Request, url: URL, env: Env): Promise<Response | null> {
  if (req.method !== 'POST' || (url.pathname !== '/_device/code' && url.pathname !== '/_device/token')) return null
  if (env.PUBLIC || !env.DB) return new Response('not found\n', { status: 404 })
  let body: { name?: unknown; device_code?: unknown }
  try { body = await req.json() } catch { return new Response('bad json\n', { status: 400 }) }

  if (url.pathname === '/_device/code') {
    const { deviceCode, userCode } = await startDevice(env, typeof body.name === 'string' ? body.name : '')
    const { app, content } = origins(url, env)
    const verify = `${app}${approvePath(url, env)}`
    return Response.json({
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verify,
      verification_uri_complete: `${verify}?code=${formatUserCode(userCode)}`,
      expires_in: DEVICE_SECONDS,
      interval: POLL_SECONDS,
      base_url: app,
      content_url: content,
    } satisfies DeviceStartResponse)
  }

  if (typeof body.device_code !== 'string') return new Response('device_code missing\n', { status: 400 })
  const r = await pollDevice(env, body.device_code)
  return Response.json(r satisfies DeviceTokenResponse, { status: 'error' in r ? 400 : 200 })
}

export const tokenInfo = (t: TokenRow): TokenInfo => ({
  id: t.id, name: t.name, created_at: t.created_at, last_used_at: t.last_used_at,
  expires_at: t.expires_at, revoked_at: t.revoked_at,
})

// rules of the install and approve pages only; buttons, inputs and the
// shell come from APP_STYLE
const TK_STYLE = `<style>
  .tk .sub{margin:.35rem 0 1.5rem}
  .step{border-left:2px solid var(--border);padding:.1rem 0 .2rem 1.25rem;margin:0 0 1.75rem}
  .step h2{margin:0;font-size:.95rem;font-weight:600}
  .step .k{display:inline-block;min-width:1.6em;line-height:1.6em;text-align:center;font-size:.85em;
    background:var(--link);color:var(--bg);border-radius:50%;margin:0 .75rem 0 -2.15rem}
  .step p{margin:.4rem 0 0;font-size:.85rem;color:var(--muted)}
  .step .cb,.tk .box .cb{margin:.6rem 0 0}
  .tk .box{margin:0 0 1.75rem;padding:.75rem 1rem}
  .tk .box h2{margin:0;font-size:.95rem}
  .tk .box.new{border-color:var(--acc2)}
  .tk .box.err{border-color:var(--danger)}
  .app form.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.8rem 0 0}
  .app table.tl{margin:.6rem 0 0}
  .tl td.n{width:100%;white-space:normal}
  .tl tr.off{color:var(--muted)}
  .app form.in{display:inline;margin:0}
  .tk div.row{display:flex;gap:.5rem;margin:.8rem 0 0}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.6rem;letter-spacing:.1em;
    margin:.6rem 0}
  .fin{color:var(--muted);font-size:.9rem}
</style>`
const STYLE = APP_STYLE + TK_STYLE

function status(t: TokenRow) {
  if (t.revoked_at) return `<span class="tag">revoked</span> ${when(t.revoked_at)}`
  if (t.expires_at && t.expires_at <= Date.now()) return '<span class="tag">expired</span>'
  return `Expires ${new Date(t.expires_at!).toISOString().slice(0, 10)}`
}

// The admin's service tokens section of /_token:
// list, revoke, and a create form with the fields of POST /_api/tokens.
async function serviceSection(env: Env) {
  const rows = (await listServiceTokens(env)).map((t) => {
    const live = !t.revoked_at && !(t.expires_at && t.expires_at <= Date.now())
    const scopes = (JSON.parse(t.scopes) as string[]).map((s) => `<code>${esc(s)}</code>`).join(' ')
    return `<tr${live ? '' : ' class="off"'}><td class="n">agent:${esc(t.name)} <small>${esc(t.id)}</small><br>${scopes}${
      t.on_behalf_of ? `<br><small>for ${esc(t.on_behalf_of)}</small>` : ''}</td>
<td>${when(t.created_at)}</td>
<td>${t.last_used_at ? `Used ${when(t.last_used_at)}` : 'Never used'}</td><td>${status(t)}</td>
<td>${live ? `<form class="in" method="post"><input type="hidden" name="action" value="service-revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="sm danger">Revoke</button></form>` : ''}</td></tr>`
  })
  return `<div class="step">
<h2>Service tokens <small>(admin)</small></h2>
<p>For agents and CI. Scopes: <code>read:&lt;collection&gt;</code> or <code>write:&lt;collection&gt;</code>, a trailing <code>*</code> matches any rest. Shares the token makes belong to the "on behalf of" person, else to the agent.</p>
${rows.length ? `<div class="scroll"><table class="tl"><tr><th>Agent and scopes</th><th>Created</th><th>Last use</th><th>Status</th><th></th></tr>${rows.join('')}</table></div>` : '<p>No service tokens yet.</p>'}
<form method="post" class="row"><input type="hidden" name="action" value="service-create">
<input name="name" placeholder="Agent name" maxlength="64" required>
<input name="scopes" placeholder="write:metareview/*" required size="24">
<input name="on_behalf_of" placeholder="On behalf of (email, optional)" size="28">
<input name="expires_days" placeholder="Days (365)" size="10">
<button class="pri">Create service token</button></form>
</div>`
}

// GET /_token; `created`: a token that was just created, shown once
export async function tokenPage(url: URL, env: Env, email: string,
  created?: { token: string; name: string; service?: boolean }, error?: string) {
  const { app, content } = origins(url, env)
  const install = `curl -fsSL ${app}/${hostKind(url, env) === 'app' ? 'install.sh' : '_install.sh'} | sh && share login`
  const skill = `mkdir -p ~/.claude/skills/mb-shares && curl -fsS ${app}/_skill -o ~/.claude/skills/mb-shares/SKILL.md`
  const rows = (await listTokens(env, email)).map((t) => {
    const live = !t.revoked_at && !(t.expires_at && t.expires_at <= Date.now())
    return `<tr${live ? '' : ' class="off"'}><td class="n">${esc(t.name)} <small>${esc(t.id)}</small></td>
<td>${when(t.created_at)}</td>
<td>${t.last_used_at ? `Used ${when(t.last_used_at)}` : 'Never used'}</td><td>${status(t)}</td>
<td>${live ? `<form class="in" method="post"><input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="sm danger">Revoke</button></form>` : ''}</td></tr>`
  })
  const shown = created?.service
    ? `<div class="box new"><h2>New service token <code>agent:${esc(created.name)}</code></h2>
<p>Shown once. Give it to the agent as its bearer token:</p>
${codeBlock(created.token)}
</div>`
    : created
    ? `<div class="box new"><h2>New token <code>${esc(created.name)}</code></h2>
<p>Shown once. This line saves it as the <code>share</code> config:</p>
${codeBlock(`(umask 077; mkdir -p ~/.config/shares && rm -f ~/.config/shares/config && printf 'BASE_URL=%s\\nCONTENT_URL=%s\\nUPLOAD_TOKEN=%s\\n' '${app}' '${content}' '${created.token}' > ~/.config/shares/config)`)}
</div>`
    : ''
  return page('Install', `${STYLE}
<div class="app tk">${nav(email, env, 'install')}
<h1>Install</h1>
<p class="sub">Publish files from your terminal or from Claude Code.</p>
${error ? `<div class="box err"><h2>Not created</h2><p>${esc(error)}</p></div>` : ''}${shown}<div class="step">
<h2><span class="k">1</span>Install the <code>share</code> CLI and log in</h2>
<p>Installs to <code>~/.local/bin</code> (macOS, Linux). <code>share login</code> opens this site to approve a new token.</p>
${codeBlock(install)}
</div>
<div class="step">
<h2><span class="k">2</span>Install the Claude Code skill <small>(optional)</small></h2>
<p>Teaches Claude Code to publish, read and pull shares. Run it again to update.</p>
${codeBlock(skill)}
</div>
<div class="step">
<h2><span class="k">3</span>Your tokens</h2>
<p>A revoked token stops working at once. <code>share logout</code> revokes the token of that machine.</p>
${rows.length ? `<div class="scroll"><table class="tl"><tr><th>Name</th><th>Created</th><th>Last use</th><th>Status</th><th></th></tr>${rows.join('')}</table></div>` : '<p>No tokens yet.</p>'}
<form method="post" class="row"><input type="hidden" name="action" value="create">
<input name="name" placeholder="Token name, e.g. laptop" maxlength="100" size="24" required><button class="pri">Create token</button></form>
</div>
${email === env.ADMIN_EMAIL ? await serviceSection(env) : ''}
<p class="fin">Then publish anything: <code>share thing.md</code> prints a URL. <code>share -h</code> for the rest</p>
</div>`, { poll: false })
}

// GET of the approve page: a code form, or the request for that code
export async function approvePage(url: URL, env: Env, email: string) {
  const code = url.searchParams.get('code') || ''
  if (!code) {
    return page('Share login', `${STYLE}<div class="app tk">${nav(email, env, null)}<h1>Share login</h1>
<p class="sub">Enter the code that <code>share login</code> printed.</p>
<form method="get" class="row"><input name="code" placeholder="XXXX-XXXX" autofocus><button class="pri">Next</button></form></div>`, { poll: false })
  }
  const d = await deviceByUserCode(env, code)
  if (!d) return message('Code unknown or expired', 'Run <code>share login</code> again.', 404)
  if (d.approved_by || d.denied) return message('Already done', 'This request was approved or denied before.')
  return page('Share login', `${STYLE}<div class="app tk">${nav(email, env, null)}<h1>Share login</h1>
<p class="sub">A <code>share</code> CLI asks for a token named <code>${esc(d.name)}</code> for <code>${esc(email)}</code>,
${when(d.created_at)}. Approve only if your terminal shows this code:</p>
<div class="code">${esc(formatUserCode(d.user_code))}</div>
<div class="row"><form method="post" class="in"><input type="hidden" name="code" value="${esc(d.user_code)}"><input type="hidden" name="action" value="approve"><button class="pri">Approve</button></form>
<form method="post" class="in"><input type="hidden" name="code" value="${esc(d.user_code)}"><input type="hidden" name="action" value="deny"><button>Deny</button></form></div>
</div>`, { poll: false })
}

function message(title: string, html: string, status = 200) {
  const r = page(title, `${STYLE}<div class="app tk"><h1>${esc(title)}</h1><p class="sub">${html}</p></div>`, { poll: false })
  return new Response(r.body, { status, headers: r.headers })
}

// POST /_token and POST of the approve page: HTML forms of a signed-in user.
// The caller checks the Origin.
export async function formPost(req: Request, url: URL, env: Env, email: string): Promise<Response> {
  if (!env.DB) return new Response('not found\n', { status: 404 })
  let form: FormData
  try { form = await req.formData() } catch { return new Response('bad form\n', { status: 400 }) }
  const action = String(form.get('action') || '')

  if (url.pathname === '/_token') {
    if (action === 'create') {
      const name = String(form.get('name') || '').trim()
      return tokenPage(url, env, email, { name, token: (await createToken(env, email, name)).token })
    }
    if (action === 'revoke') {
      await revokeToken(env, email, String(form.get('id') || ''))
      return new Response(null, { status: 303, headers: { location: '/_token' } })
    }
    if (action === 'service-create' || action === 'service-revoke') {
      if (email !== env.ADMIN_EMAIL) return new Response('forbidden\n', { status: 403 })
      if (action === 'service-revoke') {
        await revokeServiceToken(env, email, String(form.get('id') || ''))
        return new Response(null, { status: 303, headers: { location: '/_token' } })
      }
      const field = (k: string) => String(form.get(k) || '').trim()
      const days = field('expires_days')
      const spec = serviceSpec({
        name: field('name'),
        scopes: field('scopes').split(/[\s,]+/).filter(Boolean),
        on_behalf_of: field('on_behalf_of').toLowerCase() || null,
        expires_days: days ? Number(days) : undefined,
      }, env)
      if (typeof spec === 'string') {
        const r = await tokenPage(url, env, email, undefined, spec)
        return new Response(r.body, { status: 400, headers: r.headers })
      }
      const { token } = await createServiceToken(env, email,
        { name: spec.name, scopes: spec.scopes, on_behalf_of: spec.on_behalf_of, days: spec.expires_days })
      return tokenPage(url, env, email, { name: spec.name, token, service: true })
    }
    return new Response('bad action\n', { status: 400 })
  }

  if (action !== 'approve' && action !== 'deny') return new Response('bad action\n', { status: 400 })
  const ok = await decideDevice(env, String(form.get('code') || ''), email, action === 'approve')
  if (!ok) return message('Code unknown or expired', 'Run <code>share login</code> again.', 404)
  return action === 'approve'
    ? message('Approved', 'Go back to your terminal: <code>share login</code> saves the token.')
    : message('Denied', 'No token was created.')
}

