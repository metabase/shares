import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { WhoAmI } from '../src/api-types'
import { isAdmin } from '../src/env'
import { ADMIN, api, browse, userToken } from './helpers'

const DEPUTY = 'deputy@metabase.com'

describe('isAdmin', () => {
  it('accepts ADMIN_EMAIL and each entry of ADMIN_EMAILS, and nobody else', () => {
    expect(isAdmin(env, ADMIN)).toBe(true)
    expect(isAdmin(env, DEPUTY)).toBe(true)
    expect(isAdmin(env, 'nobody@metabase.com')).toBe(true)
    expect(isAdmin(env, 'ann@metabase.com')).toBe(false)
    expect(isAdmin(env, null)).toBe(false)
    expect(isAdmin({ ...env, ADMIN_EMAILS: undefined }, DEPUTY)).toBe(false)
  })
})

describe('an admin from ADMIN_EMAILS', () => {
  it('has the admin rights of ADMIN_EMAIL', async () => {
    const token = await userToken(DEPUTY)
    const who = await (await api('GET', '/_api/whoami', { token })).json<WhoAmI>()
    expect(who).toMatchObject({ email: DEPUTY, admin: true })
    const r = await api('POST', '/_api/tokens', { token, body: JSON.stringify({ name: 'deputy-bot', scopes: ['write:deputy/*'] }) })
    expect(r.status).toBe(200)
    expect((await api('GET', '/_api/tokens?kind=service', { token })).status).toBe(200)
    expect((await browse('/_stats', DEPUTY)).status).toBe(200)
  })

  it('leaves UPLOAD_TOKEN acting as ADMIN_EMAIL', async () => {
    const who = await (await api('GET', '/_api/whoami')).json<WhoAmI>()
    expect(who).toMatchObject({ email: ADMIN, admin: true })
  })

  it('gives a plain user no admin rights', async () => {
    const token = await userToken('ann@metabase.com')
    expect((await (await api('GET', '/_api/whoami', { token })).json<WhoAmI>()).admin).toBe(false)
    expect((await api('GET', '/_api/tokens?kind=service', { token })).status).toBe(403)
    expect((await browse('/_stats', 'ann@metabase.com')).status).toBe(403)
  })
})
