import type { Call } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { rangeIds } from './selection.ts'

const list = ['a', 'b', 'c', 'd'].map(id => ({ id }) as Call)

describe('rangeIds', () => {
  it('returns the calls between two ids in list order, in either direction', () => {
    expect(rangeIds(list, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeIds(list, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })
  it('is empty when an id is not in the list', () => {
    expect(rangeIds(list, 'a', 'zz')).toEqual([])
  })
})
