import type { TranscriptSegment } from '@callfront/db/types'
import { useMemo } from 'react'
import { useRows } from '../store.tsx'

export type SegmentsByCall = ReadonlyMap<string, TranscriptSegment[]>

/** Transcript segments per call, in spoken order. */
export function useSegmentsByCall(): SegmentsByCall {
  const segments = useRows('transcript_segments')
  return useMemo(() => {
    const byCall = new Map<string, TranscriptSegment[]>()
    for (const s of segments) byCall.set(s.call_id, [...(byCall.get(s.call_id) ?? []), s])
    for (const list of byCall.values()) list.sort((a, b) => a.at_ms - b.at_ms || a.version - b.version)
    return byCall
  }, [segments])
}
