// Calls at the same time before the trial (ExtraCalls.tsx, LIN-450): picked on the pick-up step, priced through the
// format helpers ("$5", never "5 $" in English), and only a choice the offer allows is kept.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ExtraCallsPicker, validExtraCalls } from './ExtraCalls.tsx'

const calls = { included: 5, step: 5, maxExtra: 45, extraCallCents: 100 }

test('only steps of the offer, up to its most, count as picked', () => {
  expect(validExtraCalls(10, calls)).toBe(10)
  expect(validExtraCalls(7, calls)).toBe(0)
  expect(validExtraCalls(50, calls)).toBe(0)
  expect(validExtraCalls(-5, calls)).toBe(0)
  expect(validExtraCalls(Number.NaN, calls)).toBe(0)
  expect(validExtraCalls(5, undefined)).toBe(0)
})

test('the picker says what is included and what more cost, in dollars as the plan prices it', () => {
  const page = renderToStaticMarkup(<ExtraCallsPicker calls={calls} extra={0} onChange={() => {}} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  expect(page).toContain('Calls at the same time')
  expect(page).toContain('5 are included. Each 5 more cost $5 a month, billed with your plan after the trial.')
  expect(page).not.toContain('5 $')
})
