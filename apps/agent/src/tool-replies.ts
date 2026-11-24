// A tool turn costs a second LLM round: after the tools ran, the model is asked again for what to say.
// For tools whose result the caller does not need to hear, that round is skipped:
// - the assistant already spoke in the same reply: nothing more to say;
// - it only flagged the call as urgent: a ready line says so and asks for the number, which the team needs to
//   call back (with caller ID: whether that number is the best one; without it, which number to call back on).
// Other tools (end_call alone) keep the model's answer.
import { type SpokenLines, spokenLines } from '@linedesk/actions'
import { voice } from '@livekit/agents'

type ToolsExecuted = { functionCalls: { name: string }[]; cancelToolReply(): void }

export const URGENT_FLAGGED_REPLY = spokenLines('en').urgentFlagged
export const URGENT_FLAGGED_NO_CALLER_ID_REPLY = spokenLines('en').urgentFlaggedNoCallerId
/** The ready replies in the language spoken now (default English). */
type Replies = () => Pick<SpokenLines, 'urgentFlagged' | 'urgentFlaggedNoCallerId'>
/** `callerId`: the call has the caller's number (callerIdOf); without it (a browser test or demo call, a withheld number) the urgent line asks for one. */
type ReplyOptions = { callerId?: boolean }
const english: Replies = () => spokenLines('en')

/**
 * Tracks whether the assistant has spoken since the caller's last line and returns the handler for
 * `FunctionToolsExecuted`. `say` speaks a fixed sentence; null (a realtime model, which has no voice to say one
 * quickly): only the reply after a turn the assistant already spoke in is skipped, the model answers the others.
 */
export function quietToolReplies(quietTools: ReadonlySet<string>, say: ((text: string) => void) | null, replies: Replies = english, { callerId = true }: ReplyOptions = {}) {
  let spokeSinceCaller = false
  return {
    itemAdded(role: string) {
      if (role === 'user') spokeSinceCaller = false
      if (role === 'assistant') spokeSinceCaller = true
    },
    toolsExecuted(event: ToolsExecuted) {
      const names = event.functionCalls.map(call => call.name)
      if (!names.length || !names.every(name => quietTools.has(name))) return
      if (spokeSinceCaller) return event.cancelToolReply()
      if (!say) return
      const urgent = callerId ? replies().urgentFlagged : replies().urgentFlaggedNoCallerId
      const reply = names.includes('flag_urgent') ? urgent : null
      if (!reply) return
      event.cancelToolReply()
      say(reply)
    },
  }
}

export function skipQuietToolReplies(session: voice.AgentSession, quietTools: ReadonlySet<string>, lines: Replies = english, { readyReplies = true, callerId = true } = {}) {
  const replies = quietToolReplies(quietTools, readyReplies ? text => void session.say(text) : null, lines, { callerId })
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.textContent) replies.itemAdded(item.role)
  })
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, event => replies.toolsExecuted(event))
}
