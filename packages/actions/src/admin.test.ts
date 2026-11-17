import { expect, test } from 'vitest'
import {
  actions,
  categoryNames,
  noPrivateEndpointText,
  noTrainingFields,
  providerGuide,
  providerSetActive,
  providerSetKeys,
  providerSpec,
  providersIn,
  REDACTED,
  redactInput,
  zeroDataRetentionOn,
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
  expect(old.error?.issues.map(i => i.code)).toEqual(['unrecognized_keys'])
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
    ['apps', ['hubspot', 'slack', 'jobber']],
    ['bot_check', ['turnstile']],
  ])
  // Sign-in apps are all in use at once: nothing to pick.
  expect(providerSetActive.input.safeParse({ category: 'sign_in', provider: 'google' }).success).toBe(false)
  // Connected apps too: each business connects the app it wants.
  expect(providerSetActive.input.safeParse({ category: 'apps', provider: 'hubspot' }).success).toBe(false)
  expect(providerSetActive.input.safeParse({ category: 'llm', provider: 'openrouter' }).success).toBe(true)
  expect(providerSetActive.input.safeParse({ category: 'llm', provider: null }).success).toBe(true)
  expect(providerSetActive.input.safeParse({ category: 'llm', provider: 'twilio' }).success).toBe(false)
})

test('only OpenRouter requests carry its rule to skip providers that train; other APIs would refuse the field', () => {
  // Zero data retention is on unless the instance admin turned it off; no training is always asked for.
  expect(noTrainingFields('https://openrouter.ai/api/v1')).toEqual({ provider: { data_collection: 'deny', zdr: true } })
  expect(noTrainingFields('https://openrouter.ai/api/v1', true)).toEqual({
    provider: { data_collection: 'deny', zdr: true },
  })
  expect(noTrainingFields('https://openrouter.ai/api/v1', false)).toEqual({ provider: { data_collection: 'deny' } })
  expect(noTrainingFields('https://api.openai.com/v1')).toEqual({})
  expect(noTrainingFields('https://api.groq.com/openai/v1', false)).toEqual({})
  expect(noTrainingFields('https://openrouter.ai.example.test/api/v1')).toEqual({})
})

test('the OpenRouter zero data retention switch is on unless it says false', () => {
  expect(zeroDataRetentionOn(undefined)).toBe(true)
  expect(zeroDataRetentionOn(null)).toBe(true)
  expect(zeroDataRetentionOn('')).toBe(true)
  expect(zeroDataRetentionOn('true')).toBe(true)
  expect(zeroDataRetentionOn('false')).toBe(false)
  expect(zeroDataRetentionOn(' false ')).toBe(false)
  const field = providerSpec('openrouter').fields.zero_data_retention
  expect(field).toMatchObject({ env: 'OPENROUTER_ZERO_DATA_RETENTION', switch: true, optional: true, secret: false })
  expect(
    providerSetKeys.input.safeParse({ provider: 'openrouter', values: { zero_data_retention: 'false' } }).success,
  ).toBe(true)
  expect(
    providerSetKeys.input.safeParse({ provider: 'openrouter', values: { zero_data_retention: 'off' } }).success,
  ).toBe(false)
})

test('OpenRouter refusing a model under the privacy routing is explained by model name, nothing else is', () => {
  const refusal =
    '{"error":{"message":"No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy","code":404}}'
  const or = 'https://openrouter.ai/api/v1'
  expect(noPrivateEndpointText(404, refusal, or, 'openai/gpt-4.1-mini', true)).toBe(
    'OpenRouter has no endpoint for the model openai/gpt-4.1-mini with zero data retention and no training on the data. Pick another model, or turn off Zero data retention only under Server admin › Providers › OpenRouter (providers that don’t train on the data stay required).',
  )
  expect(noPrivateEndpointText(404, refusal, or, 'x/free:free', false)).toContain(
    'the model x/free:free that does not train',
  )
  // Another 404 (an unknown model), another status, or another API: the usual handling.
  expect(noPrivateEndpointText(404, '{"error":{"message":"x/y is not a valid model ID"}}', or, 'x/y', true)).toBeNull()
  expect(noPrivateEndpointText(400, refusal, or, 'x/y', true)).toBeNull()
  // No endpoint for another reason (a parameter the model's providers don't take): not ours to explain.
  expect(
    noPrivateEndpointText(
      404,
      '{"error":{"message":"No endpoints found that can handle the requested parameters."}}',
      or,
      'x/y',
      true,
    ),
  ).toBeNull()
  expect(noPrivateEndpointText(404, refusal, 'https://api.openai.com/v1', 'gpt-4.1-mini', true)).toBeNull()
})

test('where only the account can stop training on calls, the guide says how, before the key is pasted', () => {
  for (const name of [
    'openrouter',
    'gemini',
    'mistral',
    'elevenlabs',
    'elevenlabs_stt',
    'elevenlabs_transcript',
    'assemblyai',
  ] as const) {
    const { steps } = providerGuide(name)
    expect(steps.at(-1), name).toMatch(/^Paste/)
    expect(steps.at(-2), name).toMatch(/train|improve/)
  }
  expect(providerGuide('gemini').steps.at(-2)).toContain('billing')
  // OpenAI, Anthropic and Groq don't train on API data: nothing to add.
  for (const name of ['openai', 'anthropic', 'groq'] as const)
    expect(providerGuide(name).steps.join(' '), name).not.toMatch(/train/)
})
