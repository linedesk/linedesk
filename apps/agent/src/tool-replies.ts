// A tool turn costs a second LLM round: after the tools ran, the model is asked again for what to say.
// For tools whose result the caller does not need to hear, that round is skipped:
// - the assistant already spoke in the same reply: nothing more to say;
// - it only called tools and a message was saved: a ready confirmation is spoken instead, which starts
//   with the voice's first audio (~0.15 s) instead of another LLM round (~0.6 to 1 s).
// Otherwise (an urgent flag alone, without words) the model still answers, since what to ask next
// depends on the conversation.
import { voice } from '@livekit/agents'

type ToolsExecuted = { functionCalls: { name: string }[]; cancelToolReply(): void }

export const MESSAGE_SAVED_REPLY = "Thanks, I've passed your message on, and the team will get back to you. Is there anything else I can help with?"

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
      if (names.includes('take_message')) {
        event.cancelToolReply()
        say(MESSAGE_SAVED_REPLY)
      }
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
