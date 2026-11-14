import { expect, test } from 'vitest'
import { canTry } from './TryOut.tsx'

test('the numbers lookup runs only with an area code from the list; the other round trips need none', () => {
  expect(canTry('telephony', '971')).toBe(true)
  // The picker leaves the value empty while what is typed is no code from the list.
  expect(canTry('telephony', '')).toBe(false)
  expect(canTry('telephony', '555')).toBe(false)
  expect(canTry('telephony', '800')).toBe(false)
  expect(canTry('llm', '')).toBe(true)
  expect(canTry('email', '')).toBe(true)
})
