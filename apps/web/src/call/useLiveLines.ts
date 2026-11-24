// What is being said right now on a live call, from the voice agent's transcription streams
// (settings/liveTranscript.ts): shown after the transcript rows until each turn syncs in as a row.
// Used by the test call (settings/TestCall.tsx) and by listening in to a call (call/liveSession.ts).
import type { TranscriptSegment } from '@linedesk/db/types'
import type { Room, TextStreamReader } from 'livekit-client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyChunk,
  FINAL_ATTRIBUTE,
  finishLine,
  type LiveLines,
  type LiveSpeaker,
  pendingLines,
  pruneLines,
  rowsOf,
  SEGMENT_ATTRIBUTE,
  TRANSCRIPTION_TOPIC,
} from '../settings/liveTranscript.ts'

/** Which of the room's transcription streams is the caller's speech (the rest is the assistant's). */
export type CallerStream = (reader: TextStreamReader, from: { identity: string }, room: Room) => boolean

/** The stream transcribes a track its sender does not publish: someone else's speech, the caller's. */
export const transcribesOthers: CallerStream = (reader, from, room) => {
  const track = reader.info.attributes?.['lk.transcribed_track_id']
  const sender = room.remoteParticipants.get(from.identity)
  return !!track && !sender?.trackPublications.has(track)
}

export function useLiveLines(rows: TranscriptSegment[]) {
  const [lines, setLines] = useState<LiveLines>([])
  const [now, setNow] = useState(Date.now)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  // A finished line waits a few seconds for its row; this re-checks while there are lines.
  useEffect(() => {
    if (lines.length === 0) return
    const id = setInterval(() => {
      const at = Date.now()
      setNow(at)
      setLines(current => pruneLines(current, rowsRef.current, at))
    }, 1000)
    return () => clearInterval(id)
  }, [lines.length])

  /** Reads one stream into its line. The caller's line is replaced by each update, the assistant's grows. Stable across renders. */
  const read = useCallback(async (reader: TextStreamReader, speaker: LiveSpeaker) => {
    const id = reader.info.attributes?.[SEGMENT_ATTRIBUTE] ?? reader.info.id
    const final = reader.info.attributes?.[FINAL_ATTRIBUTE] === 'true'
    const mode = speaker === 'caller' ? 'replace' : 'append'
    const rowsBefore = rowsOf(rowsRef.current, speaker)
    try {
      for await (const text of reader)
        setLines(current => applyChunk(current, { id, speaker, text, mode, final, now: Date.now(), rowsBefore }))
    } catch {
      // A stream cut off by the hang-up: what arrived stays until the row replaces it.
    }
    setLines(current => finishLine(current, id, Date.now()))
  }, [])
  const clear = useCallback(() => setLines([]), [])

  return {
    pending: useMemo(() => pendingLines(lines, rows, now), [lines, rows, now]),
    read,
    /** Reads every transcription stream of the room; `isCaller` tells the caller's from the assistant's. */
    listen(room: Room, isCaller: CallerStream = transcribesOthers) {
      room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, (reader, from) => {
        void read(reader, isCaller(reader, from, room) ? 'caller' : 'agent')
      })
    },
    clear,
  }
}
