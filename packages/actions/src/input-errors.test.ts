import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { actions } from './index.ts'
import { inputErrorText } from './input-errors.ts'

const textFor = (name: string, input: unknown) => {
  const parsed = actions.get(name)!.input.safeParse(input)
  if (parsed.success) throw new Error('expected invalid input')
  return inputErrorText(parsed.error, input)
}

describe('invalid input as plain sentences', () => {
  it('names the field and what it must be', () => {
    expect(textFor('team.setRole', { memberId: 'm1', role: 'owner' })).toBe('Role must be one of admin, member.')
    expect(textFor('team.invite', { email: 'not an email', role: 'member' })).toBe('Email must be an email address.')
    expect(textFor('team.setRole', { role: 'admin' })).toBe('MemberId is required.')
  })

  it('says every problem, one sentence each', () => {
    expect(textFor('team.setRole', {})).toBe('MemberId is required. Role is required.')
  })

  it('keeps messages a schema wrote itself, and never prints JSON', () => {
    const schema = z.object({ name: z.string().trim().min(1), tags: z.array(z.string()).max(2) }).strict()
    const parsed = schema.safeParse({ name: ' ', tags: ['a', 'b', 'c'], extra: 1 })
    const text = inputErrorText(parsed.error!)
    expect(text).toBe('Name must not be empty. Tags takes at most 2. Has unknown field extra.')
    expect(text).not.toMatch(/[[{]/)
    const custom = z.string().refine(() => false, { message: 'that provider belongs to another category' }).safeParse('x')
    expect(inputErrorText(custom.error!)).toBe('That provider belongs to another category.')
  })
})
