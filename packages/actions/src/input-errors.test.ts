import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { actions } from './index.ts'
import { DESTRUCTIVE_ACTIONS, droppedFields, fieldLabel, inputErrorText, unknownFieldsText } from './input-errors.ts'
import { providerNames } from './admin.ts'

const textFor = (name: string, input: unknown) => {
  const parsed = actions.get(name)!.input.safeParse(input)
  if (parsed.success) throw new Error('expected invalid input')
  return inputErrorText(parsed.error, input)
}

describe('invalid input as plain sentences', () => {
  it('names the field and what it must be', () => {
    expect(textFor('team.invite', { email: 'a@b.co', role: 'owner' })).toBe('Role must be one of admin, member.')
    expect(textFor('team.invite', { email: 'not an email', role: 'member' })).toBe('Email must be an email address.')
    expect(textFor('team.setRole', { role: 'admin' })).toBe('Member ID is required.')
  })

  it('says every problem, one sentence each', () => {
    expect(textFor('team.setRole', {})).toBe('Member ID is required. Role is required.')
  })

  it('names a nested field as people say it, never by its path', () => {
    const text = textFor('carrier.set', {
      carrier: 'twilio',
      values: { account_sid: 'nope', auth_token: 'secret-token-1234567890' },
    })
    expect(text).toBe('The Account SID starts with AC followed by 32 letters and digits.')
    const schema = z.object({ hours: z.array(z.object({ startTime: z.string() })), apiKeyId: z.string().email() })
    const sent = { hours: [{ startTime: 1 }], apiKeyId: 'x' }
    expect(inputErrorText(schema.safeParse(sent).error!, sent)).toBe('Start time must be a string. API key ID must be an email address.')
    expect(fieldLabel(['values', 'account_sid'])).toBe('account SID')
  })

  it('finds the fields Zod dropped, at any depth, but not the keys of a record', () => {
    const schema = z.object({ name: z.string(), voice: z.object({ id: z.string() }).optional(), tags: z.record(z.string(), z.string()) })
    const sent = { name: 'Maya', voice_provider: 'x', voice: { id: 'v', speed: 2 }, tags: { any: 'key' } }
    expect(droppedFields(sent, schema.parse(sent))).toEqual(['voice_provider', 'voice.speed'])
    expect(droppedFields({ name: 'Maya', tags: {} }, schema.parse({ name: 'Maya', tags: {} }))).toEqual([])
    expect(unknownFieldsText(['voice_provider'])).toBe('This action does not take the field voice_provider.')
  })

  it('keeps messages a schema wrote itself, and never prints JSON', () => {
    const schema = z.object({ name: z.string().trim().min(1), tags: z.array(z.string()).max(2) }).strict()
    const parsed = schema.safeParse({ name: ' ', tags: ['a', 'b', 'c'], extra: 1 })
    const text = inputErrorText(parsed.error!)
    expect(text).toBe('Name must not be empty. Tags takes at most 2. This action does not take the field extra.')
    expect(text).not.toMatch(/[[{]/)
    const custom = z.string().refine(() => false, { message: 'that provider belongs to another category' }).safeParse('x')
    expect(inputErrorText(custom.error!)).toBe('That provider belongs to another category.')
  })
})

/** A valid input for each destructive action, so only the extra field is wrong. */
const DESTRUCTIVE_INPUTS: Record<(typeof DESTRUCTIVE_ACTIONS)[number], Record<string, unknown>> = {
  'workspace.delete': { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', keepAccounts: true },
  'workspace.deleteOwn': { name: 'Brightwater Plumbing & Heating', keepOwnAccount: true },
  'membership.remove': { memberId: 'mem_1', keepAccount: true },
  'team.removeMember': { memberId: 'mem_1', deleteAccount: false },
  'team.leave': { deleteAccount: false },
  'phoneNumber.release': { phoneNumberId: 'pn_1', confirm: '+1 503 555 0100' },
  'apiKey.revoke': { apiKeyId: 'key_1' },
  'personalKey.revoke': { personalKeyId: 'pk_1' },
  'agentSetup.revoke': {},
  'agentSetup.revokeWorkspace': {},
  'agentSetup.endOwnAccess': {},
  'webhook.delete': { endpointId: 'wh_1' },
  'integration.remove': { subscriptionId: 'sub_1' },
  'calendar.disconnect': { connectionId: 'cal_1' },
  'user.resetPasskeys': { userId: 'user_1' },
  'account.authenticatorRemove': {},
  'provider.clearKeys': { provider: providerNames[0] },
}

describe('destructive actions take no field they do not know (security review F2 of #756)', () => {
  it.each(DESTRUCTIVE_ACTIONS)('%s: its input is strict', name => {
    const def = actions.get(name)
    expect(def, name).toBeDefined()
    const valid = DESTRUCTIVE_INPUTS[name]
    expect(def!.input.safeParse(valid).success).toBe(true)
    const parsed = def!.input.safeParse({ ...valid, keepUsers: true })
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: ['keepUsers'] })])
    expect(inputErrorText(parsed.error!, { ...valid, keepUsers: true })).toBe('This action does not take the field keepUsers.')
  })
})
