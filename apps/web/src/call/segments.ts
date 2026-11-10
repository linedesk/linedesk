import type { TranscriptSegment } from '@callfront/db/types'
import { useMemo } from 'react'
import { useRows } from '../store.tsx'

export type SegmentsByCall = ReadonlyMap<string, TranscriptSegment[]>

/** Segments per call in spoken order; segments with the same time keep the order they were written in. */
export function groupSegments(segments: TranscriptSegment[]): SegmentsByCall {
  const byCall = new Map<string, TranscriptSegment[]>()
  for (const s of segments) {
    const list = byCall.get(s.call_id)
    if (list) list.push(s)
    else byCall.set(s.call_id, [s])
  }
  for (const list of byCall.values()) list.sort((a, b) => a.at_ms - b.at_ms || a.version - b.version)
  return byCall
}

/** Transcript segments per call, in spoken order. */
export function useSegmentsByCall(): SegmentsByCall {
  const segments = useRows('transcript_segments')
  return useMemo(() => groupSegments(segments), [segments])
}
