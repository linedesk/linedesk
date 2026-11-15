import { describe, expect, test } from 'vitest'
import {
  providerFailureAdvice,
  providerFailureReason,
  providerFailureReasonOfText,
  providerFailureReasons,
  providerFailureText,
  isPerCallProviderError,
  PROVIDER_ERROR_SUMMARY_MAX,
  providerErrorSummary,
} from './provider-health.ts'

describe('providerFailureReason: one vocabulary for the API and the voice agent', () => {
  test.each([
    [{ status: 401, text: '{"detail":{"status":"quota_exceeded"}}' }, 'quota'], // ElevenLabs out of credits
    [{ status: 429, text: '{"error":{"code":"insufficient_quota"}}' }, 'quota'], // OpenAI
    [{ status: 402 }, 'quota'],
    [{ status: 429, text: '{"error":{"code":"rate_limit_exceeded"}}' }, 'network'],
    [{ status: 401, text: '{"detail":{"status":"missing_permissions"}}' }, 'permission'],
    [{ status: 401 }, 'auth'],
    [{ status: 403, text: 'Invalid API key' }, 'auth'],
    [{ status: 403, text: 'Forbidden' }, 'permission'],
    [{ status: 404 }, 'not_found'],
    [{ status: 400, text: 'x is not a valid model ID' }, 'not_found'],
    [{ status: 400, text: 'bad sample rate' }, 'config'],
    [{ status: 504 }, 'timeout'],
    [{ status: 503 }, 'network'],
    [{ text: 'websocket closed: quota exceeded' }, 'quota'],
    [{ text: 'request timed out' }, 'timeout'],
    [{ text: 'no audio frames' }, 'no_output'],
    [{ text: 'something odd' }, 'unknown'],
  ] as const)('%j → %s', (input, reason) => {
    expect(providerFailureReason(input)).toBe(reason)
  })
})

describe('providerFailureText: one text per reason, for whoever reads it', () => {
  test('admins are sent to Server admin › Providers, members to whoever runs the server', () => {
    expect(providerFailureText('quota', 'ElevenLabs', 'admin')).toBe(
      'ElevenLabs has used up its quota or credit. Add credit or raise the limit at ElevenLabs, then test it under Server admin › Providers.',
    )
    expect(providerFailureText('auth', 'The phone carrier', 'member')).toBe(
      'The phone carrier rejected the key it was given. Ask whoever runs this server to check the key.',
    )
  })

  test('a passing problem says to try again; every reason has a problem and a fix', () => {
    expect(providerFailureText('network', 'Telnyx', 'member')).toBe(
      'Telnyx is not reachable right now. Try again in a moment. If it keeps failing, ask whoever runs this server.',
    )
    for (const reason of providerFailureReasons)
      for (const audience of ['admin', 'member'] as const) {
        const { problem, fix } = providerFailureAdvice(reason, 'X', audience)
        expect(problem).toMatch(/^(The key for )?X /)
        expect(fix).toMatch(audience === 'admin' ? /Server admin › Providers/ : /whoever runs this server|Try again/)
      }
  })

  test('the reason in a text that reached the browser', () => {
    expect(providerFailureReasonOfText('telnyx: POST /number_orders: Authentication failed (HTTP 401)')).toBe('auth')
    expect(providerFailureReasonOfText('telnyx: POST /number_orders: Insufficient balance')).toBe('quota')
    expect(providerFailureReasonOfText('telnyx: GET /x: Telnyx did not answer within 10 s')).toBe('timeout')
    expect(providerFailureReasonOfText('something odd')).toBe('unknown')
  })
})

const ACTIVE_RESPONSE =
  'Conversation already has an active response in progress: resp_DfQ9xXkT2ab. Wait until the response is finished before creating a new one. {"type":"invalid_request_error","code":"conversation_already_has_active_response","message":"Conversation already has an active response in progress: re'

describe('providerErrorSummary: one short line for people, never raw JSON', () => {
  test.each([
    [ACTIVE_RESPONSE, 'A call sent two replies at once. Calls still work.'],
    ['Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com.', 'The API key is not accepted.'],
    ['HTTP 401 {"error":"unauthorized"}', 'The API key is not accepted.'],
    ['You exceeded your current quota, please check your plan and billing details.', "The provider's limit or credit is used up."],
    ['HTTP 429 Too Many Requests', "The provider's limit or credit is used up."],
    ['The model gpt-x does not exist. Pick another one. {"error":{"code":"model_not_found"}}', 'The model gpt-x does not exist.'],
    ['Socket closed {"code":1006}', 'Socket closed'],
    ['{"error":"x"}', '{"error":"x"}'],
  ])('%s', (text, expected) => expect(providerErrorSummary(text)).toBe(expected))

  test('a long unbroken text is cut to one line with an ellipsis', () => {
    const line = providerErrorSummary('x'.repeat(500))
    expect(line.length).toBe(PROVIDER_ERROR_SUMMARY_MAX)
    expect(line.endsWith('…')).toBe(true)
  })
})

test('isPerCallProviderError: our own conversation races, not a provider outage', () => {
  expect(isPerCallProviderError(ACTIVE_RESPONSE)).toBe(true)
  expect(isPerCallProviderError('Cancellation failed: no active response found')).toBe(true)
  expect(isPerCallProviderError('Incorrect API key provided')).toBe(false)
  expect(isPerCallProviderError('You exceeded your current quota')).toBe(false)
})
