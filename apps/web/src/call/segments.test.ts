import type { TranscriptSegment } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { groupSegments } from './segments.ts'

const segment = (id: string, call_id: string, at_ms: number, version: number) => ({ id, call_id, at_ms, version }) as TranscriptSegment

describe('transcript segments', () => {
  it('groups by call and sorts by time, then by write order', () => {
    const grouped = groupSegments([segment('b2', 'b', 500, 9), segment('a3', 'a', 4000, 3), segment('a1', 'a', 0, 1), segment('a2-tool', 'a', 4000, 2), segment('b1', 'b', 0, 8)])
    expect(grouped.get('a')!.map(s => s.id)).toEqual(['a1', 'a2-tool', 'a3'])
    expect(grouped.get('b')!.map(s => s.id)).toEqual(['b1', 'b2'])
    expect(grouped.get('missing')).toBeUndefined()
  })
})
