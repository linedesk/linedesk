import type { TranscriptSegment } from '@linedesk/db/types'

/** Shown while the call is running: the assistant is on the line, plus the latest thing it did. */
export function LiveCard({ segments, assistantName }: { segments: TranscriptSegment[]; assistantName: string }) {
  const lastEvent = segments.findLast(s => s.tool_event)?.tool_event
  return (
    <section className="lvc" aria-live="polite">
      <div className="lvc-row">
        <span className="lvc-bars on">{[0, 1, 2, 3, 4].map(i => <i key={i} />)}</span>
        <span className="lvc-who">{assistantName} is on the call…</span>
      </div>
      {lastEvent && <p className="lvc-note">{lastEvent.label}</p>}
    </section>
  )
}
