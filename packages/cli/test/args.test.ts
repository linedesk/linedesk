import { describe, expect, it } from 'vitest'
import { actionInput, parseArgs } from '../src/args.ts'

describe('parseArgs', () => {
  it('reads words, options with a value, flags and --name=value', () => {
    const { words, options } = parseArgs(['call.markDone', '--callId', 'c_1', '--yes', 'x', '--limit=5', '--raw'])
    expect(words).toEqual(['call.markDone', 'x'])
    expect(Object.fromEntries(options)).toEqual({ callId: 'c_1', yes: true, limit: '5', raw: true })
  })
  it('takes everything after -- as words', () => {
    expect(parseArgs(['get', '--', '--odd']).words).toEqual(['get', '--odd'])
  })
})

describe('actionInput', () => {
  it('builds the input from --json and fields, nested with dots, leaving out the CLI options', () => {
    const { options } = parseArgs([
      '--json',
      '{"a":1}',
      '--patch.name',
      'Mike',
      '--done',
      'true',
      '--workspace',
      'w_1',
      '--yes',
    ])
    expect(actionInput(options)).toEqual({ a: 1, patch: { name: 'Mike' }, done: true })
  })
  it('keeps a field the schema types as text as text', () => {
    const { options } = parseArgs(['--phone', '5035550100', '--count', '3'])
    expect(actionInput(options, new Set(['phone']))).toEqual({ phone: '5035550100', count: 3 })
  })
  it('refuses field names that would reach the prototype', () => {
    expect(() => actionInput(parseArgs(['--__proto__.x', '1']).options)).toThrow(/not a field name/)
  })
  it('refuses --json that is not an object', () => {
    expect(() => actionInput(parseArgs(['--json', '[1]']).options)).toThrow(/JSON object/)
  })
})
