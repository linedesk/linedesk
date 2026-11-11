// Command-line arguments of setup-sip and setup-oncall-test. Both set a trunk's whole number list, so an
// unknown flag (a typo, --help) or a missing number is refused with the usage, never replaced by a default.
import { type SimulatedAnswer, simulatedAnswers } from './on-call-dialer.ts'

const E164 = /^\+[1-9]\d{6,14}$/

export const SETUP_SIP_USAGE = [
  'usage: setup-sip [--outbound] <+1NUMBER> [+1NUMBER ...]',
  '       setup-sip --print-allowed-addresses',
  'The inbound trunk takes exactly the numbers given: pass every number that must keep reaching the assistant.',
].join('\n')

export const SETUP_ONCALL_TEST_USAGE = [
  `usage: setup-oncall-test <+1NUMBER> [--answer ${simulatedAnswers.join('|')}]`,
  'Routes calls to the test on-call number to the on-call responder (live warm-transfer test).',
].join('\n')

const fail = (problem: string, usage: string) => new Error(`${problem}\n\n${usage}`)

function numbersOf(values: string[], usage: string): string[] {
  if (!values.length) throw fail('No number given.', usage)
  const invalid = values.filter(value => !E164.test(value))
  if (invalid.length) throw fail(`Not a number in E.164 form (+15035550142): ${invalid.join(', ')}`, usage)
  return values
}

export type SetupSipArgs =
  | { printAllowedAddresses: true }
  | { printAllowedAddresses: false; outbound: boolean; numbers: string[] }

export function parseSetupSipArgs(args: string[]): SetupSipArgs {
  const flags = args.filter(arg => arg.startsWith('-'))
  const unknown = flags.filter(flag => flag !== '--outbound' && flag !== '--print-allowed-addresses')
  if (unknown.length) throw fail(`Unknown option: ${unknown.join(', ')}`, SETUP_SIP_USAGE)
  if (flags.includes('--print-allowed-addresses')) return { printAllowedAddresses: true }
  const numbers = numbersOf(
    args.filter(arg => !arg.startsWith('-')),
    SETUP_SIP_USAGE,
  )
  return { printAllowedAddresses: false, outbound: flags.includes('--outbound'), numbers }
}

export type SetupOnCallTestArgs = { number: string; answer: SimulatedAnswer }

export function parseSetupOnCallTestArgs(args: string[]): SetupOnCallTestArgs {
  const rest = [...args]
  let answer: SimulatedAnswer = 'accept'
  const at = rest.indexOf('--answer')
  if (at >= 0) {
    const value = simulatedAnswers.find(a => a === rest[at + 1])
    if (!value) throw fail(`--answer takes one of ${simulatedAnswers.join(', ')}`, SETUP_ONCALL_TEST_USAGE)
    answer = value
    rest.splice(at, 2)
  }
  const unknown = rest.filter(arg => arg.startsWith('-'))
  if (unknown.length) throw fail(`Unknown option: ${unknown.join(', ')}`, SETUP_ONCALL_TEST_USAGE)
  const numbers = numbersOf(rest, SETUP_ONCALL_TEST_USAGE)
  if (numbers.length > 1) throw fail('Give one test on-call number.', SETUP_ONCALL_TEST_USAGE)
  return { number: numbers[0]!, answer }
}
