// A tool turn costs a second LLM round: after the tools ran, the model is asked again for what to say.
// For tools whose result the caller does not need to hear, that round is skipped:
// - the assistant already spoke in the same reply: nothing more to say;
// - it only called tools and a message was saved: a ready confirmation is spoken instead, which starts
//   with the voice's first audio (~0.15 s) instead of another LLM round (~0.6 to 1 s).
// - it only flagged the call as urgent: a ready line says so and asks for the number, which every
//   message needs.
// Other tools (end_call alone) keep the model's answer.
import { voice } from '@livekit/agents'

type ToolsExecuted = { functionCalls: { name: string }[]; cancelToolReply(): void }

export const MESSAGE_SAVED_REPLY = "Thanks, I've passed your message on, and the team will get back to you. Is there anything else I can help with?"
export const URGENT_FLAGGED_REPLY = "I've marked this as urgent for the team. Is the number you're calling from the best way to reach you?"

/**
 * Tracks whether the assistant has spoken since the caller's last line and returns the handler for
 * `FunctionToolsExecuted`. `say` speaks a fixed sentence.
 */
export function quietToolReplies(quietTools: ReadonlySet<string>, say: (text: string) => void) {
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
      const reply = names.includes('take_message') ? MESSAGE_SAVED_REPLY : names.includes('flag_urgent') ? URGENT_FLAGGED_REPLY : null
      if (!reply) return
      event.cancelToolReply()
      say(reply)
    },
  }
}

export function skipQuietToolReplies(session: voice.AgentSession, quietTools: ReadonlySet<string>) {
  const replies = quietToolReplies(quietTools, text => void session.say(text))
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.textContent) replies.itemAdded(item.role)
  })
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, event => replies.toolsExecuted(event))
}
