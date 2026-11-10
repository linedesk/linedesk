import type { TranscriptSegment } from '@callfront/db/types'
import type { ReactNode } from 'react'
import { highlight } from '../inbox/search.tsx'
import { clock } from '../time.ts'
import type { IconName } from '../ui/icons.ts'
import { cx, Icon } from '../ui/kit.tsx'

type Props = {
  segments: TranscriptSegment[]
  callerName: string
  assistantName: string
  search: string | null
  /** Where the call began and how it ended, as the first and last line. */
  start: { time: string; label: string }
  end: { time: string; label: string } | null
}

const toolIcons: Record<string, IconName> = { 'call.flagUrgent': 'spark', 'call.takeMessage': 'message' }

/** A line between the bubbles: the call's start or end, or something the assistant did. */
function EventLine({ icon, label, time }: { icon: IconName | null; label: string; time: string }) {
  return (
    <div className="k-event" role="note">
      <span className="k-event-in">{icon && <Icon name={icon} size={14} />}<span>{label}</span><time>{time}</time></span>
    </div>
  )
}

/** A system or tool line between the bubbles, e.g. "Flagged urgent". */
function CallEvent({ segment }: { segment: TranscriptSegment }) {
  const icon = segment.tool_event ? toolIcons[segment.tool_event.tool] ?? 'spark' : null
  return <EventLine icon={icon} label={segment.tool_event?.label ?? segment.text} time={clock(segment.at_ms / 1000)} />
}

function Bubble({ fromCaller, author, time, children }: { fromCaller: boolean; author: string | null; time: string; children: ReactNode }) {
  return (
    <div className={cx('k-msg', fromCaller ? 'k-msg-them' : 'k-msg-me', author && 'k-msg-tail')}>
      <div className={cx('k-bubble', fromCaller ? 'k-tone-signal' : 'k-tone-neutral')}>
        {author && <div className="k-msg-author">{author}</div>}
        <span className="k-msg-text">{children}</span>
        <span className="k-meta-space" aria-hidden="true" />
        <span className="k-meta"><time>{time}</time></span>
      </div>
    </div>
  )
}

/** The conversation in spoken order. The speaker's name shows when the speaker changes. */
export function Transcript({ segments, callerName, assistantName, search, start, end }: Props) {
  const names: Record<string, string> = { caller: callerName, agent: assistantName, human: 'Team' }
  let previous: string | null = null
  return (
    <div>
      <EventLine icon="phone-in" label={start.label} time={start.time} />
      {segments.map(s => {
        if (s.speaker === 'system') { previous = null; return <CallEvent key={s.id} segment={s} /> }
        const speakerChanged = previous !== s.speaker
        previous = s.speaker
        return (
          <Bubble key={s.id} fromCaller={s.speaker === 'caller'} author={speakerChanged ? names[s.speaker]! : null} time={clock(s.at_ms / 1000)}>
            {highlight(s.text, search)}
          </Bubble>
        )
      })}
      {end && <EventLine icon="phone-off" label={end.label} time={end.time} />}
    </div>
  )
}
