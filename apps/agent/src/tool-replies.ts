// A tool turn costs a second LLM round: after the tools ran, the model is asked again for what to say.
// For tools whose result the caller does not need to hear (a saved message, an urgent flag), that round
// is skipped when the assistant already spoke in the same reply: the caller hears no gap after it.
import { voice } from '@livekit/agents'

type ToolsExecuted = { functionCalls: { name: string }[]; cancelToolReply(): void }

/**
 * Tracks whether the assistant has spoken since the caller's last line and returns the handler for
 * `FunctionToolsExecuted`: it cancels the follow-up reply when every tool is in `quietTools` and the
 * assistant already said something. Without spoken text the follow-up stays, so the caller hears a reply.
 */
export function quietToolReplies(quietTools: ReadonlySet<string>) {
  let spokeSinceCaller = false
  return {
    itemAdded(role: string) {
      if (role === 'user') spokeSinceCaller = false
      if (role === 'assistant') spokeSinceCaller = true
    },
    toolsExecuted(event: ToolsExecuted) {
      if (spokeSinceCaller && event.functionCalls.every(call => quietTools.has(call.name))) event.cancelToolReply()
    },
  }
}

export function skipQuietToolReplies(session: voice.AgentSession, quietTools: ReadonlySet<string>) {
  const replies = quietToolReplies(quietTools)
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.textContent) replies.itemAdded(item.role)
  })
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, event => replies.toolsExecuted(event))
}
