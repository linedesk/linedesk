import { expect, test } from 'vitest'
import {
  actions,
  categoryNames,
  providerSetActive,
  providerSetKeys,
  providersIn,
  REDACTED,
  redactInput,
} from './index.ts'

const SECRET = 'KEY-made-up-0123456789'

test('every admin area action needs instance:admin, which no role has', () => {
  const names = [
    'provider.setKeys',
    'provider.clearKeys',
    'provider.setActive',
    'provider.test',
    'user.disable',
    'user.enable',
    'user.invite',
    'workspace.disable',
    'workspace.enable',
    'workspace.delete',
    'instanceAdmin.grant',
    'instanceAdmin.revoke',
    'user.resetPasskeys',
    'user.issuePasskeyEnrolment',
  ]
  for (const name of names) expect(actions.get(name)?.permission, name).toBe('instance:admin')
})

test('workspace.delete takes keepAccounts; the old name keepUsers is refused as an unknown field (E14, F2 of #756)', () => {
  const def = actions.get('workspace.delete')!
  const base = { workspaceId: 'ws1', name: 'Brightwater Plumbing & Heating' }
  expect(def.input.parse({ ...base, keepAccounts: true })).toEqual({ ...base, keepAccounts: true })
  const old = def.input.safeParse({ ...base, keepUsers: true })
  expect(old.success).toBe(false)
  expect(old.error?.issues.map((i) => i.code)).toEqual(['unrecognized_keys'])
  expect(def.input.parse(base)).toEqual(base)
  expect(def.input.safeParse({ ...base, keepAccounts: 'yes' }).success).toBe(false)
})

test('sensitive fields keep their keys and lose their values', () => {
  const input = { provider: 'twilio', values: { account_sid: 'ACmadeup', auth_token: SECRET } }
  const redacted = redactInput(providerSetKeys, input)
  expect(redacted).toEqual({ provider: 'twilio', values: { account_sid: REDACTED, auth_token: REDACTED } })
  expect(JSON.stringify(redacted)).not.toContain(SECRET)
  expect(input.values.auth_token).toBe(SECRET) // the handler still gets the real input
  expect(redactInput({ sensitive: ['token', 'list'] }, { token: SECRET, list: [SECRET], other: 1 })).toEqual({
    token: REDACTED,
    list: REDACTED,
    other: 1,
  })
  expect(redactInput({}, input)).toBe(input)
})

test('provider.setKeys accepts only fields of that provider and never repeats a value in an error', () => {
  expect(providerSetKeys.input.safeParse({ provider: 'telnyx', values: { api_key: ` ${SECRET}\n` } }).data).toEqual({
    provider: 'telnyx',
    values: { api_key: SECRET },
  })
  const wrong = [
    { provider: 'telnyx', values: { api_secret: SECRET } },
    { provider: 'telnyx', values: {} },
    { provider: 'telnyx', values: { api_key: '' } },
    { provider: 'unknown', values: { api_key: SECRET } },
    { provider: 'livekit', values: { api_secret: SECRET } },
    { provider: 'openai', values: { api_key: SECRET.repeat(200) } },
    { provider: 'openai', values: { api_key: 42, extra: { nested: SECRET } } },
  ]
  for (const input of wrong) {
    const parsed = providerSetKeys.input.safeParse(input)
    expect(parsed.success, JSON.stringify(input).slice(0, 80)).toBe(false)
    expect(parsed.error?.message).not.toContain(SECRET)
  }
})

test('every provider has a category, and the first of each category is the default', () => {
  expect(categoryNames.map(category => [category, providersIn(category)])).toEqual([
    ['telephony', ['telnyx', 'twilio']],
    ['stt', ['deepgram', 'elevenlabs_stt', 'openai_stt']],
    ['llm', ['openai', 'openrouter', 'anthropic', 'gemini', 'groq', 'mistral']],
    ['tts', ['elevenlabs', 'cartesia']],
    ['realtime', ['openai_realtime']],
    ['email', ['smtp', 'resend', 'postmark', 'sendgrid', 'brevo', 'mailgun', 'gmail']],
    ['sign_in', ['google', 'microsoft', 'calendly', 'calcom', 'github', 'oidc']],
    ['recording', ['file', 's3']],
    ['transcript', ['openai_transcript', 'deepgram_transcript', 'assemblyai', 'elevenlabs_transcript']],
    ['business', ['google_places']],
    ['billing', ['stripe']],
    ['apps', ['hubspot']],
  ])
  // Sign-in apps are all in use at once: nothing to pick.
  expect(providerSetActive.input.safeParse({ category: 'sign_in', provider: 'google' }).success).toBe(false)
  // Connected apps too: each business connects the app it wants.
  expect(providerSetActive.input.safeParse({ category: 'apps', provider: 'hubspot' }).success).toBe(false)
  expect(providerSetActive.input.safeParse({ category: 'llm', provider: 'openrouter' }).success).toBe(true)
  expect(providerSetActive.input.safeParse({ category: 'llm', provider: null }).success).toBe(true)
  expect(providerSetActive.input.safeParse({ category: 'llm', provider: 'twilio' }).success).toBe(false)
})
