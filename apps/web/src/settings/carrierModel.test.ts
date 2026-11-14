import type { CarrierStatusData } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  carrierChoiceText,
  carrierInput,
  carrierSummary,
  draftErrors,
  existingNumbersText,
  initialDraft,
  isChanged,
  visibleFields,
} from './carrierModel.ts'

const SID = `AC${'a1'.repeat(16)}`
const KEY_SID = `SK${'b2'.repeat(16)}`
const defaultStatus: CarrierStatusData = {
  carrier: 'default',
  canStore: true,
  sipReady: true,
  fields: [],
  updatedAt: null,
}
const field = (name: string, set: boolean, value: string | null = null, secret = false) => ({
  field: name,
  label: name,
  secret,
  set,
  value,
  last4: secret && set ? '1234' : null,
})
const twilioWithKey: CarrierStatusData = {
  carrier: 'twilio',
  canStore: true,
  sipReady: true,
  updatedAt: '2026-11-11T09:00:00.000Z',
  fields: [
    field('account_sid', true, SID),
    field('api_key_sid', true, KEY_SID),
    field('api_key_secret', true, null, true),
    field('auth_token', false, null, true),
  ],
}

describe('carrier form', () => {
  test('opens on the saved carrier with the SIDs filled in and no secret', () => {
    expect(initialDraft(defaultStatus)).toEqual({
      carrier: 'default',
      twilioAuth: 'api_key',
      values: { account_sid: '', api_key_sid: '', public_key: '' },
    })
    expect(initialDraft(twilioWithKey)).toEqual({
      carrier: 'twilio',
      twilioAuth: 'api_key',
      values: { account_sid: SID, api_key_sid: KEY_SID, public_key: '' },
    })
  })

  test('shows the fields of the carrier and of the chosen Twilio sign-in', () => {
    const draft = initialDraft(defaultStatus)
    expect(visibleFields(draft)).toEqual([])
    expect(visibleFields({ ...draft, carrier: 'telnyx' })).toEqual(['api_key', 'public_key'])
    expect(draftErrors({ ...draft, carrier: 'telnyx', values: { api_key: 'KEY' } })).toEqual({})
    expect(carrierInput({ ...draft, carrier: 'telnyx', values: { api_key: 'KEY', public_key: '' } })).toEqual({
      carrier: 'telnyx',
      values: { api_key: 'KEY' },
    })
    expect(visibleFields({ ...draft, carrier: 'twilio' })).toEqual(['account_sid', 'api_key_sid', 'api_key_secret'])
    expect(visibleFields({ ...draft, carrier: 'twilio', twilioAuth: 'auth_token' })).toEqual([
      'account_sid',
      'auth_token',
    ])
  })

  test('unchanged means Test connection; a typed secret or another carrier means Save', () => {
    const draft = initialDraft(twilioWithKey)
    expect(isChanged(draft, twilioWithKey)).toBe(false)
    expect(isChanged({ ...draft, values: { ...draft.values, api_key_secret: 'new' } }, twilioWithKey)).toBe(true)
    expect(isChanged({ ...draft, carrier: 'default' }, twilioWithKey)).toBe(true)
  })

  test('every shown field is required, SIDs are checked, credentials go as a whole', () => {
    const draft = {
      carrier: 'twilio' as const,
      twilioAuth: 'api_key' as const,
      values: { account_sid: 'AC1', api_key_sid: KEY_SID },
    }
    expect(draftErrors(draft)).toEqual({
      account_sid: 'Starts with AC and 32 letters and digits',
      api_key_secret: 'Required',
    })
    const good = {
      ...draft,
      values: { account_sid: ` ${SID} `, api_key_sid: KEY_SID, api_key_secret: 'secret', auth_token: 'left over' },
    }
    expect(draftErrors(good)).toEqual({})
    expect(carrierInput(good)).toEqual({
      carrier: 'twilio',
      values: { account_sid: SID, api_key_sid: KEY_SID, api_key_secret: 'secret' },
    })
    expect(carrierInput({ ...good, carrier: 'default' })).toEqual({ carrier: 'default' })
  })

  test('the summary names the account without its whole SID', () => {
    expect(carrierSummary(defaultStatus)).toBe('Linedesk default')
    expect(carrierSummary(twilioWithKey)).toBe(`Your own Twilio · ACa1a1…a1a1`)
    expect(carrierSummary({ ...defaultStatus, carrier: 'telnyx' })).toBe('Your own Telnyx')
  })
})

describe('carrier copy', () => {
  test("the default names the server's carrier when it is known", () => {
    expect(carrierChoiceText('default', 'telnyx')).toBe(
      'Simplest, nothing to set up. Numbers come from Telnyx, set up by whoever runs this server.',
    )
    expect(carrierChoiceText('default', null)).toBe(
      'Simplest, nothing to set up. Numbers come from the carrier whoever runs this server set up.',
    )
    expect(carrierChoiceText('default', 'dev')).toContain('Development mode')
  })
  test('an own account says who bills and what it needs', () => {
    expect(carrierChoiceText('twilio', 'telnyx')).toBe(
      'You have a Twilio account already. New numbers are bought there, and Twilio bills you. Needs your Twilio API key, entered here.',
    )
    expect(carrierChoiceText('telnyx', null)).toContain('Telnyx bills you')
  })
  test('numbers in the own account block a switch; other numbers stay as they are', () => {
    expect(existingNumbersText('twilio', 1)).toBe(
      'Your number stays in your Twilio account. To switch, disconnect it first.',
    )
    expect(existingNumbersText('telnyx', 3)).toBe(
      'Your 3 numbers stay in your Telnyx account. To switch, disconnect them first.',
    )
    expect(existingNumbersText('twilio', 0)).toBe(
      'Numbers you already have stay connected as they are. The choice only applies to new numbers.',
    )
    expect(existingNumbersText('default', 2)).toBe(existingNumbersText('twilio', 0))
  })
})
