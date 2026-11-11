import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { actions } from './index.ts'
import { droppedFields, fieldLabel, inputErrorText, unknownFieldsText } from './input-errors.ts'

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
