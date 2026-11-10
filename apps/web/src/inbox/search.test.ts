import type { Call, TranscriptSegment } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { matchesSearch, searchHit } from './search.tsx'

const call = { id: 'c', from_number: '+15035550111', title: 'Leaking pipe', summary: 'Water under the sink.', status: 'completed' } as Call
const segments = [{ speaker: 'caller', text: 'The basement is flooding', at_ms: 65_000 }] as TranscriptSegment[]
const item = { call, contact: { name: 'Emily Carter', company: null } as never, segments, assistantName: 'Maya' }

describe('search', () => {
  it('matches caller, number, title, summary and transcript, ignoring case', () => {
    for (const q of ['emily', '555 0111', '5550111', 'LEAKING', 'under the sink', 'flooding']) expect(matchesSearch(item, q)).toBe(true)
    expect(matchesSearch(item, 'boiler')).toBe(false)
  })
  it('reports where a transcript match is', () => {
    expect(searchHit(item, 'flooding')).toEqual({ field: 'Emily Carter', text: 'The basement is flooding', atMs: 65_000 })
    expect(searchHit(item, 'sink')?.field).toBe('Summary')
  })
})

describe('search query', () => {
  it('ignores spaces around the query', () => {
    expect(matchesSearch(item, '  flooding ')).toBe(true)
    expect(searchHit(item, ' sink  ')?.field).toBe('Summary')
  })
})

describe('search matching', () => {
  it('finds a number however it is written', () => {
    for (const q of ['(503) 555-0111', '503-555-0111', '503.555.0111', '+1 503 555 0111', '5035550111', '555 0111']) expect(matchesSearch(item, q)).toBe(true)
    expect(matchesSearch(item, '(503) 555-0199')).toBe(false)
  })
  it('matches all words in any order, across caller and content', () => {
    expect(matchesSearch(item, 'carter emily')).toBe(true)
    expect(matchesSearch(item, 'flooding emily')).toBe(true) // transcript word and caller name
    expect(matchesSearch(item, 'emily boiler')).toBe(false) // every word has to be there
  })
  it('points at the text that holds a word when the whole query is nowhere in one piece', () => {
    expect(searchHit(item, 'emily flooding')).toEqual({ field: 'Emily Carter', text: 'The basement is flooding', atMs: 65_000 })
  })
})
