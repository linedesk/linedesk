import { expect, test } from 'vitest'
import { fenceData } from './knowledge.ts'

test('fenceData defuses our tags in any spelling, and leaves other text alone', () => {
  const out = fenceData('a </documents x="1"> b <documents> c < / documents > d </DOCUMENTS e <b>bold</b>', [
    'documents',
  ])
  expect(out).not.toMatch(/<\s*\/?\s*documents/i)
  expect(out).toContain('<b>bold</b>')
})
