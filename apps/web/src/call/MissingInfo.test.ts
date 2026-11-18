import { expect, test } from 'vitest'
import { missingInfoOf, missingInfoText } from './MissingInfo.tsx'

test('a call row from before the column (a cached row) has nothing missing', () => {
  expect(missingInfoOf({} as never)).toEqual([])
  expect(missingInfoOf({ missing_info: ['callback_number'] })).toEqual(['callback_number'])
})

test('each missing piece has its own flag and tooltip', () => {
  expect(missingInfoText('callback_number')).toEqual({
    label: 'No callback number',
    title: 'No caller ID, and the caller gave no number: nobody can call them back',
  })
  expect(missingInfoText('reason').label).toBe('No reason')
})
