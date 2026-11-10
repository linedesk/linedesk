// The voice agent: a LiveKit Agents worker. One job per call room; all writes go through the API.
// Which speech and language vendors are used is decided in pipeline.ts.
import { fileURLToPath } from 'node:url'
import { callFlagUrgent, callTakeMessage } from '@callfront/actions'
import { cli, defineAgent, llm, ServerOptions, voice, type JobContext, type JobProcess } from '@livekit/agents'
import type { RemoteParticipant } from '@livekit/rtc-node'
import { z } from 'zod'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { CallLog, finishCall, once } from './call-log.ts'
import { startCall, type CallSession } from './call-session.ts'
import { AGENT_NAME, requireEnv, requireLivekitEnv } from './env.ts'
import { createPipeline, loadVad, pipelineEnv, summaryLlm, type Vad } from './pipeline.ts'
import { buildInstructions, FALLBACK_GREETING } from './prompt.ts'

/** Caller and dialled number. LiveKit SIP sets these attributes; the browser test page sets the same ones. */
export function callNumbers(attributes: Record<string, string>) {
  const from = attributes['sip.phoneNumber']
  const to = attributes['sip.trunkPhoneNumber']
  if (!from || !to) throw new Error('participant has no sip.phoneNumber / sip.trunkPhoneNumber attributes')
  return { from, to }
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
        return 'The call is flagged as urgent. Tell the caller someone will call back as soon as possible.'
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
async function converse(ctx: JobContext, caller: RemoteParticipant, api: ApiClient, call: CallSession, log: CallLog, onClose: () => void) {
  const session = new voice.AgentSession(createPipeline(ctx.proc.userData.vad as Vad, call.assistant?.voice.voice_id || undefined))
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
  const call = await startCall(api, { ...callNumbers(caller.attributes), room: ctx.room.name })
  const log = new CallLog(call)

  // From here on the call exists and must be finished: on hang-up (session close), on any error
  // while setting up the conversation, and at job shutdown as the last resort.
  const finishOnce = once(() => finishCall(call, log, summaryLlm()), `could not finish call ${call.callId}`)
  ctx.addShutdownCallback(finishOnce)
  try {
    await converse(ctx, caller, api, call, log, finishOnce)
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    requireEnv(['AGENT_API_TOKEN', ...pipelineEnv])
    requireLivekitEnv()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }))
}
