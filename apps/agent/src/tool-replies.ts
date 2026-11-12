// A tool turn costs a second LLM round: after the tools ran, the model is asked again for what to say.
// For tools whose result the caller does not need to hear, that round is skipped:
// - the assistant already spoke in the same reply: nothing more to say;
// - it only called tools and a message was saved: a ready confirmation is spoken instead, which starts
//   with the voice's first audio (~0.15 s) instead of another LLM round (~0.6 to 1 s).
// - it only flagged the call as urgent: a ready line says so and asks for the number, which every
//   message needs.
// Other tools (end_call alone) keep the model's answer.
import { type SpokenLines, spokenLines } from '@linedesk/actions'
import { voice } from '@livekit/agents'

type ToolsExecuted = { functionCalls: { name: string }[]; cancelToolReply(): void }

export const MESSAGE_SAVED_REPLY = spokenLines('en').messageSaved
export const URGENT_FLAGGED_REPLY = spokenLines('en').urgentFlagged

/** The ready replies in the language spoken now (default English). */
type Replies = () => Pick<SpokenLines, 'messageSaved' | 'urgentFlagged'>
const english: Replies = () => spokenLines('en')

/**
 * Tracks whether the assistant has spoken since the caller's last line and returns the handler for
 * `FunctionToolsExecuted`. `say` speaks a fixed sentence; null (a realtime model, which has no voice to say one
 * quickly): only the reply after a turn the assistant already spoke in is skipped, the model answers the others.
 */
export function quietToolReplies(quietTools: ReadonlySet<string>, say: ((text: string) => void) | null, replies: Replies = english) {
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
      const reply = names.includes('take_message') ? replies().messageSaved : names.includes('flag_urgent') ? replies().urgentFlagged : null
      if (!reply) return
      event.cancelToolReply()
      say(reply)
    },
  }
}

export function skipQuietToolReplies(session: voice.AgentSession, quietTools: ReadonlySet<string>, lines: Replies = english, { readyReplies = true } = {}) {
  const replies = quietToolReplies(quietTools, readyReplies ? text => void session.say(text) : null, lines)
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.textContent) replies.itemAdded(item.role)
  })
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, event => replies.toolsExecuted(event))
}
