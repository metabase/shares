// Token pages and the device flow endpoints. The pages need a session
// (/_token: list, create, revoke; the approve page of `share login`); the
// device endpoints need nothing: the device code is the credential.

import type { Env } from '../env'
import type { DeviceStartResponse, DeviceTokenResponse, TokenInfo } from '../api-types'
import { ago, esc, page } from '../render/page'
import { appBase, contentBase, hostKind } from '../origins'
import {
  DEVICE_SECONDS, POLL_SECONDS, createToken, decideDevice, deviceByUserCode, formatUserCode, listTokens,
  pollDevice, revokeToken, startDevice, type TokenRow,
} from '../tokens'

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

const STYLE = `<style>
  .tk h1{margin:0;font-size:1.3rem}
  .tk .sub{color:var(--muted);margin:.35rem 0 1.5rem}
  .step{border:1px solid var(--border);border-radius:10px;padding:1rem 1.25rem;margin:0 0 1rem}
  .step h2{margin:0;font-size:.95rem;font-weight:600}
  .step .k{display:inline-block;min-width:1.5em;text-align:center;font-size:.85em;
    background:var(--code-bg);border:1px solid var(--border);border-radius:6px;
    margin-right:.5em;color:var(--muted)}
  .step p{margin:.4rem 0 0;font-size:.85rem;color:var(--muted)}
  .step pre{width:100%;min-width:0;max-width:none;left:0;transform:none;
    margin:.6rem 0 0;font-size:.78rem;white-space:pre-wrap;overflow-wrap:anywhere}
  table.tl{display:table;width:100%;min-width:0;max-width:none;left:auto;transform:none;
    background:none;padding:0;font-size:.85rem;margin:.6rem 0 0;border-collapse:collapse}
  .tl th{text-align:left;color:var(--muted);font-weight:normal}
  .tl td,.tl th{border:0;border-bottom:1px solid var(--border);padding:.3em .4em;white-space:nowrap}
  .tl td.n{width:100%;white-space:normal}
  .tl tr.off{color:var(--muted)}
  form.in{display:inline;margin:0}
  button,input{font:inherit;font-size:.8rem}
  button{color:var(--fg);background:none;border:1px solid var(--border);border-radius:5px;
    padding:.1em .6em;cursor:pointer}
  button:hover{border-color:var(--muted)}
  button.go{border-color:var(--acc2);color:var(--acc2)}
  input{background:var(--code-bg);color:var(--fg);border:1px solid var(--border);border-radius:5px;
    padding:.15em .5em}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.6rem;letter-spacing:.1em;
    margin:.6rem 0}
  .fin{color:var(--muted);font-size:.9rem}
</style>`

function status(t: TokenRow) {
  if (t.revoked_at) return `revoked ${ago(t.revoked_at)}`
  if (t.expires_at && t.expires_at <= Date.now()) return 'expired'
  return `expires ${new Date(t.expires_at!).toISOString().slice(0, 10)}`
}

// GET /_token; `created`: a token that was just created, shown once
export async function tokenPage(url: URL, env: Env, email: string, created?: { token: string; name: string }) {
  const { app, content } = origins(url, env)
  const install = `mkdir -p ~/bin && curl -fsS ${app}/_cli -o ~/bin/share && chmod +x ~/bin/share && share login`
  const skill = `mkdir -p ~/.claude/skills/mb-shares && curl -fsS ${app}/_skill -o ~/.claude/skills/mb-shares/SKILL.md`
  const rows = (await listTokens(env, email)).map((t) => {
    const live = !t.revoked_at && !(t.expires_at && t.expires_at <= Date.now())
    return `<tr${live ? '' : ' class="off"'}><td class="n">${esc(t.name)} <small>${esc(t.id)}</small></td>
<td title="${new Date(t.created_at).toISOString()}">${ago(t.created_at)}</td>
<td>${t.last_used_at ? `used ${ago(t.last_used_at)}` : 'never used'}</td><td>${status(t)}</td>
<td>${live ? `<form class="in" method="post"><input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button>revoke</button></form>` : ''}</td></tr>`
  })
  const shown = created
    ? `<div class="step"><h2>new token <code>${esc(created.name)}</code></h2>
<p>shown once. This line saves it as the <code>share</code> config:</p>
<pre><code>${esc(`mkdir -p ~/.config/shares && (umask 077; printf 'BASE_URL=%s\\nCONTENT_URL=%s\\nUPLOAD_TOKEN=%s\\n' '${app}' '${content}' '${created.token}' > ~/.config/shares/config)`)}</code></pre>
</div>`
    : ''
  return page('cli setup', `${STYLE}
<div class="tk">
<h1>cli setup</h1>
<p class="sub">signed in as <code>${esc(email)}</code></p>
${shown}<div class="step">
<h2><span class="k">1</span>install the <code>share</code> cli and log in</h2>
<p>needs <code>~/bin</code> on your PATH. <code>share login</code> opens this site to approve a new token.</p>
<pre><code>${esc(install)}</code></pre>
</div>
<div class="step">
<h2><span class="k">2</span>install / update the claude code skill <small>(optional)</small></h2>
<p>teaches Claude Code to publish, read, and pull shares. Re-run anytime to pull the latest version.</p>
<pre><code>${esc(skill)}</code></pre>
</div>
<div class="step">
<h2>your tokens</h2>
<p>a revoked token stops working at once. <code>share logout</code> revokes the token of that machine.</p>
${rows.length ? `<table class="tl"><tr><th>name</th><th>created</th><th>last use</th><th>status</th><th></th></tr>${rows.join('')}</table>` : '<p>no tokens yet</p>'}
<form method="post" style="margin:.8rem 0 0"><input type="hidden" name="action" value="create">
<input name="name" placeholder="token name" maxlength="100" required> <button>create token</button></form>
</div>
<p class="fin">then publish anything: <code>share thing.md</code> prints a URL. <code>share -h</code> for the rest</p>
</div>`, { poll: false })
}

// GET of the approve page: a code form, or the request for that code
export async function approvePage(url: URL, env: Env, email: string) {
  const code = url.searchParams.get('code') || ''
  if (!code) {
    return page('share login', `${STYLE}<div class="tk"><h1>share login</h1>
<p class="sub">enter the code that <code>share login</code> printed</p>
<form method="get"><input name="code" placeholder="XXXX-XXXX" autofocus> <button>next</button></form></div>`, { poll: false })
  }
  const d = await deviceByUserCode(env, code)
  if (!d) return message('code unknown or expired', 'run <code>share login</code> again.', 404)
  if (d.approved_by || d.denied) return message('already done', 'this request was approved or denied before.')
  return page('share login', `${STYLE}<div class="tk"><h1>share login</h1>
<p class="sub">a <code>share</code> cli asks for a token named <code>${esc(d.name)}</code> for <code>${esc(email)}</code>,
${ago(d.created_at)}. Approve only if your terminal shows this code:</p>
<div class="code">${esc(formatUserCode(d.user_code))}</div>
<form method="post" class="in"><input type="hidden" name="code" value="${esc(d.user_code)}"><input type="hidden" name="action" value="approve"><button class="go">approve</button></form>
<form method="post" class="in"><input type="hidden" name="code" value="${esc(d.user_code)}"><input type="hidden" name="action" value="deny"><button>deny</button></form>
</div>`, { poll: false })
}

function message(title: string, html: string, status = 200) {
  const r = page(title, `${STYLE}<div class="tk"><h1>${esc(title)}</h1><p class="sub">${html}</p></div>`, { poll: false })
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
    return new Response('bad action\n', { status: 400 })
  }

  if (action !== 'approve' && action !== 'deny') return new Response('bad action\n', { status: 400 })
  const ok = await decideDevice(env, String(form.get('code') || ''), email, action === 'approve')
  if (!ok) return message('code unknown or expired', 'run <code>share login</code> again.', 404)
  return action === 'approve'
    ? message('approved', 'go back to your terminal: <code>share login</code> saves the token.')
    : message('denied', 'no token was created.')
}

