// The voice agent: a LiveKit Agents worker. One job per call room; all writes go through the API.
// Which speech and language vendors are used is decided in pipeline.ts.
import { fileURLToPath } from 'node:url'
import { callFlagUrgent, callTakeMessage } from '@callfront/actions'
import { cli, defineAgent, llm, ServerOptions, voice, type JobContext, type JobProcess } from '@livekit/agents'
import type { RemoteParticipant } from '@livekit/rtc-node'
import { z } from 'zod'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { CallLog, finishCall, hangUp, once, RECORDING_WAIT_MS } from './call-log.ts'
import { callOrigin, startCall, type CallSession } from './call-session.ts'
import { createConfigLoader, parseProviderSettings, type AgentConfig } from './config.ts'
import { AGENT_NAME, requireEnv, requireLivekitEnv } from './env.ts'
import { checkReadiness, declineCall, describeReadiness } from './not-ready.ts'
import { createPipeline, loadVad, summaryLlm, type Vad } from './pipeline.ts'
import { buildInstructions, FALLBACK_GREETING } from './prompt.ts'
import { describeRecording, livekitRecorder, saveRecording, startRecording, stopRecording } from './recording.ts'

let configLoader: (() => Promise<AgentConfig>) | undefined
/** The effective provider config: Linedesk's provider settings first, the environment as fallback, cached briefly per process. */
function loadAgentConfig(): Promise<AgentConfig> {
  configLoader ??= createConfigLoader({ fetchSettings: async () => parseProviderSettings(await apiClientFromEnv().providerSettings()) })
  return configLoader()
}

/** A test call ends by itself after this long, so a forgotten browser tab does not run up provider minutes. */
export const TEST_CALL_LIMIT_MS = 5 * 60_000

/** Deleting the room disconnects the browser; the session then closes and the call is finished as usual. */
function endTestCallLater(ctx: JobContext) {
  const timer = setTimeout(() => void ctx.deleteRoom().catch(() => {}), TEST_CALL_LIMIT_MS)
  timer.unref()
  ctx.addShutdownCallback(async () => clearTimeout(timer))
}

function assistantTools(api: ApiClient, call: CallSession, log: CallLog) {
  const { callId, workspaceId } = call
  return {
    take_message: llm.tool({
      description: 'Save a message for the team. Use it whenever the caller wants a callback, a visit, a quote or anything you cannot do yourself.',
      parameters: z.object({ message: z.string().describe('One complete sentence: who wants what, and how to reach them.') }),
      execute: async ({ message }) => {
        await api.run(callTakeMessage, { callId, message }, workspaceId)
        log.messages.push(message)
        log.record('system', 'Took a message', callTakeMessage.name)
        return 'The message is saved. Tell the caller the team will get back to them.'
      },
    }),
    flag_urgent: llm.tool({
      description: 'Flag this call as urgent. Use it for emergencies that need a person right away.',
      execute: async () => {
        await api.run(callFlagUrgent, { callId }, workspaceId)
        log.urgent = true
        log.record('system', 'Flagged as urgent', callFlagUrgent.name)
        return 'The call is flagged as urgent for the team. Take a message now; do not promise a response time.'
      },
    }),
  }
}

function recordConversation(session: voice.AgentSession, log: CallLog) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || !item.textContent) return
    if (item.role === 'user') log.record('caller', item.textContent)
    if (item.role === 'assistant') log.record('agent', item.textContent)
  })
}

/** Greets the caller and runs the conversation until the session closes. */
async function converse(ctx: JobContext, caller: RemoteParticipant, api: ApiClient, config: AgentConfig, call: CallSession, log: CallLog, onClose: () => void) {
  const session = new voice.AgentSession(createPipeline(ctx.proc.userData.vad as Vad, config, call.assistant?.voice))
  recordConversation(session, log)
  session.on(voice.AgentSessionEventTypes.Close, onClose)
  await session.start({
    agent: new voice.Agent({ instructions: buildInstructions(call.assistant), tools: assistantTools(api, call, log) }),
    room: ctx.room,
    inputOptions: { participantIdentity: caller.identity, closeOnDisconnect: true },
  })
  session.say(call.assistant?.greeting || FALLBACK_GREETING)
}

async function entry(ctx: JobContext) {
  await ctx.connect()
  const caller = await ctx.waitForParticipant()
  const api = apiClientFromEnv()
  const origin = callOrigin(ctx.job.metadata, caller.attributes, ctx.room.name ?? '')
  const call = await startCall(api, origin)

  // Checked at every call: until the providers are configured the call is logged as missed and ended.
  const readiness = await checkReadiness(loadAgentConfig)
  if (!readiness.ready) {
    await declineCall(call, readiness, () => ctx.deleteRoom())
    return ctx.shutdown('assistant not set up')
  }
  const { config } = readiness
  const log = new CallLog(call)

  // From here on the call exists and must be finished: on hang-up (session close), on any error
  // while setting up the conversation, and at job shutdown as the last resort.
  const recorder = livekitRecorder()
  const recording = startRecording(recorder, call, ctx.room.name ?? call.callId)
  const finish = () => hangUp({
    stopRecording: async () => stopRecording(recorder, await recording),
    finishCall: () => finishCall(call, log, summaryLlm(config)),
    saveRecording: async () => saveRecording(api, call, recorder, await recording, RECORDING_WAIT_MS),
  })
  const finishOnce = once(finish, `could not finish call ${call.callId}`)
  ctx.addShutdownCallback(finishOnce)
  try {
    await converse(ctx, caller, api, config, call, log, finishOnce)
    if (origin.kind === 'test') endTestCallLater(ctx)
  } catch (e) {
    await finishOnce()
    throw e
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await loadVad()
  },
  entry,
})

/**
 * A self-hosted stack starts the agent with everything else. Until it is configured it waits
 * instead of exiting, so the container stays up; it takes calls after a restart with the settings.
 */
function idle(reason: string) {
  console.log(`Voice agent is idle: ${reason} Calls are not answered until this is set and the agent is restarted.`)
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  setInterval(() => {}, 2 ** 30)
}

async function main() {
  try {
    // The worker cannot run without LiveKit and the API; it can run without speech and LLM keys.
    requireEnv(['AGENT_API_TOKEN'])
    if (process.env.AGENT_API_TOKEN === 'change-me') throw new Error('AGENT_API_TOKEN is still the placeholder from .env.example.')
    requireLivekitEnv()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    if (process.env.NODE_ENV === 'production') return idle(reason)
    console.error(reason)
    process.exit(1)
  }
  console.log(describeReadiness(await checkReadiness(loadAgentConfig)))
  console.log(describeRecording())
  // Processes kept warm for the next call; the library's default is one per CPU core (up to four).
  const numIdleProcesses = Number(process.env.AGENT_IDLE_PROCESSES) || undefined
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME, numIdleProcesses }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
