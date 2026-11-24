import { describe, expect, test } from 'vitest'
import { carrierGet, carrierSet, carrierTest } from './carrier.ts'
import { REDACTED, redactInput, rolePermissions } from './define.ts'

const SID = `AC${'0f'.repeat(16)}`
const KEY_SID = `SK${'0f'.repeat(16)}`

describe('carrier actions', () => {
  test('owners and admins only; no patch, so nothing is applied in the browser', () => {
    for (const def of [carrierSet, carrierGet, carrierTest]) {
      expect(def.permission).toBe('settings:write')
      expect(rolePermissions.member).not.toContain(def.permission)
      expect(rolePermissions.agent).not.toContain(def.permission)
      expect(def.patch).toBeUndefined()
    }
    expect(carrierGet.readOnly).toBe(true)
    expect(carrierTest.readOnly).toBe(true)
    expect(carrierSet.readOnly).toBeUndefined()
  })

  test('the credentials are redacted in the command log', () => {
    const input = carrierSet.input.parse({ carrier: 'telnyx', values: { api_key: 'KEY123' } })
    expect(redactInput(carrierSet, input)).toEqual({ carrier: 'telnyx', values: { api_key: REDACTED } })
  })

  test('Twilio takes an API key or the auth token, never both or half a key', () => {
    const ok = (values: object) => carrierSet.input.safeParse({ carrier: 'twilio', values }).success
    expect(ok({ account_sid: SID, auth_token: 'token' })).toBe(true)
    expect(ok({ account_sid: SID, api_key_sid: KEY_SID, api_key_secret: 'secret' })).toBe(true)
    expect(ok({ account_sid: SID })).toBe(false)
    expect(ok({ account_sid: SID, api_key_sid: KEY_SID })).toBe(false)
    expect(ok({ account_sid: SID, api_key_secret: 'secret', auth_token: 'token' })).toBe(false)
    expect(ok({ account_sid: SID, auth_token: 'token', api_key_sid: KEY_SID, api_key_secret: 'secret' })).toBe(false)
    expect(ok({ account_sid: 'AC/../x', auth_token: 'token' })).toBe(false)
    expect(ok({ account_sid: SID, auth_token: 'token', other: 'x' })).toBe(false)
  })

  test('default takes no credentials; Telnyx only its API key', () => {
    expect(carrierSet.input.safeParse({ carrier: 'default' }).success).toBe(true)
    expect(carrierSet.input.safeParse({ carrier: 'default', values: { api_key: 'x' } }).success).toBe(false)
    expect(carrierSet.input.safeParse({ carrier: 'telnyx', values: { api_key: 'KEY' } }).success).toBe(true)
    expect(carrierSet.input.safeParse({ carrier: 'telnyx', values: {} }).success).toBe(false)
    expect(carrierSet.input.safeParse({ carrier: 'plivo', values: {} }).success).toBe(false)
  })
})
