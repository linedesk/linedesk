// What is being said right now on a test call, before it is a transcript row. The voice agent
// publishes LiveKit's transcription text streams (topic lk.transcription): the caller's speech as
// it is recognised (each update replaces the last) and the assistant's words as they are spoken
// (each chunk adds to the last). The finished turn arrives as a transcript row through sync; until
// then the panel shows the line from the stream.
import type { TranscriptSegment } from '@linedesk/db/types'

export const TRANSCRIPTION_TOPIC = 'lk.transcription'
export const FINAL_ATTRIBUTE = 'lk.transcription_final'
export const SEGMENT_ATTRIBUTE = 'lk.segment_id'

/** How long a finished line waits for its transcript row before it is dropped anyway. */
export const FINAL_LINE_TTL_MS = 6000

export type LiveSpeaker = 'caller' | 'agent'
export type LiveLine = {
  id: string
  speaker: LiveSpeaker
  text: string
  /** When the line was finished (ms since epoch); null while it is still being spoken. */
  finishedAt: number | null
  /** How many transcript rows the speaker had when the line began: only later rows can be its own. */
  rowsBefore: number
}
export type LiveLines = readonly LiveLine[]

export type Chunk = {
  id: string
  speaker: LiveSpeaker
  text: string
  /** The caller's recognised speech replaces the line; the assistant's words add to it. */
  mode: 'replace' | 'append'
  final: boolean
  now: number
  /** The speaker's transcript rows so far. */
  rowsBefore: number
}

/** The lines after one chunk of a stream. */
export function applyChunk(lines: LiveLines, chunk: Chunk): LiveLines {
  const current = lines.find(l => l.id === chunk.id)
  const text = chunk.mode === 'append' && current ? current.text + chunk.text : chunk.text
  const next: LiveLine = {
    id: chunk.id,
    speaker: chunk.speaker,
    text,
    finishedAt: current?.finishedAt ?? (chunk.final ? chunk.now : null),
    rowsBefore: current?.rowsBefore ?? chunk.rowsBefore,
  }
  return current ? lines.map(l => (l.id === chunk.id ? next : l)) : [...lines, next]
}

/** Marks a stream's line finished (its stream closed). */
export function finishLine(lines: LiveLines, id: string, now: number): LiveLines {
  return lines.map(l => (l.id === id && l.finishedAt === null ? { ...l, finishedAt: now } : l))
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** A row says the same as the line (an interrupted reply is spoken only in part, so either may be the start of the other). */
function sameTurn(row: TranscriptSegment, line: LiveLine): boolean {
  const a = words(row.text)
  const b = words(line.text)
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a))
}

/**
 * Lines still to show after the transcript rows: those still being spoken, and finished ones whose
 * row has not synced in yet (for at most FINAL_LINE_TTL_MS). Empty text is never shown.
 */
export function pendingLines(lines: LiveLines, rows: readonly TranscriptSegment[], now: number): LiveLines {
  return lines.filter(line => {
    if (!words(line.text)) return false
    const later = rows.filter(r => r.speaker === line.speaker).slice(line.rowsBefore)
    if (later.some(row => sameTurn(row, line))) return false
    return line.finishedAt === null || now - line.finishedAt < FINAL_LINE_TTL_MS
  })
}

/** The speaker's transcript rows so far, for a new line's rowsBefore. */
export const rowsOf = (rows: readonly TranscriptSegment[], speaker: LiveSpeaker) =>
  rows.filter(r => r.speaker === speaker).length

/** Drops lines that will never be shown again, so the list stays short on a long call. */
export function pruneLines(lines: LiveLines, rows: readonly TranscriptSegment[], now: number): LiveLines {
  const shown = new Set(pendingLines(lines, rows, now).map(l => l.id))
  return lines.filter(l => l.finishedAt === null || shown.has(l.id))
}
