// The assistant hangs up after the goodbye: once its last words have played, not in the middle of them.
import { voice } from '@livekit/agents'

/** Longest wait for the goodbye to finish playing before the line is cut anyway. */
export const GOODBYE_PLAYOUT_MAX_MS = 6000
/** A short pause after the last word, so the line does not cut the end of it. */
const AFTER_SPEECH_MS = 400

type Speaking = { agentState: string; onDone(listener: () => void): void }

/** Calls `hangUp` once the agent is no longer speaking (after a short pause), at the latest after the cap. */
export function hangUpAfterSpeech(agent: Speaking, hangUp: () => void, maxMs = GOODBYE_PLAYOUT_MAX_MS) {
  let done = false
  const once = () => {
    if (done) return
    done = true
    hangUp()
  }
  setTimeout(once, maxMs).unref?.()
  if (agent.agentState !== 'speaking') return void setTimeout(once, AFTER_SPEECH_MS).unref?.()
  agent.onDone(() => setTimeout(once, AFTER_SPEECH_MS).unref?.())
}

/** The session as `hangUpAfterSpeech` needs it. */
export function speakingOf(session: voice.AgentSession): Speaking {
  return {
    get agentState() {
      return session.agentState
    },
    onDone(listener) {
      const onState = ({ newState }: { newState: string }) => {
        if (newState === 'speaking') return
        session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState)
        listener()
      }
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState)
    },
  }
}
