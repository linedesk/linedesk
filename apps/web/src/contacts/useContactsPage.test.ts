import { describe, expect, it } from 'vitest'
import { type Place, placeFromHash } from './useContactsPage.ts'

const left: Place = { query: 'mi', searching: true, cursorId: 'a', openId: null, creating: true }

describe('a link to one contact (C9)', () => {
  it('opens that contact and puts the cursor on it', () => {
    expect(placeFromHash(left, '#contacts/ct_9')).toEqual({
      ...left,
      cursorId: 'ct_9',
      openId: 'ct_9',
      creating: false,
    })
  })
  it('keeps the place the page was left in for any other address', () => {
    expect(placeFromHash(left, '#contacts')).toBe(left)
    expect(placeFromHash(left, '#call/c1')).toBe(left)
  })
})
