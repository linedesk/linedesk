// The assistant's transfer_call tool: puts an urgent caller through to the on-call phone (warm
// transfer, transfer-call.ts) and records how it went with call.transfer.
import { callTransfer } from '@linedesk/actions'
import { llm, type JobContext } from '@livekit/agents'
import { type RemoteParticipant, RoomEvent } from '@livekit/rtc-node'
import { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import type { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import type { AgentConfig } from './config.ts'
import type { Announcement } from './audio-bridge.ts'
import { requireLivekitEnv } from './env.ts'
import { createGreetingCache, greetingKey, synthesize } from './greeting-cache.ts'
import { createTts, greetingVoice } from './pipeline.ts'
import { type OnCallDialer, simulatedDialer, sipDialer } from './on-call-dialer.ts'
import { findOutboundTrunk, sipClient, TRANSFER_TRUNK_NAME } from './sip-trunks.ts'
import { ownTransferTrunk, reprovisionTrunk, transferRoute, workspaceTrunkDialer } from './workspace-trunk.ts'
import { briefingText, CONNECTING_LINE, NOT_CONNECTED_REPLY, transferLabel } from './transfer.ts'
import { type Livekit, warmTransfer } from './transfer-call.ts'

const livekitOf = (): Livekit => {
  const env = requireLivekitEnv()
  return { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET }
}

/** The trunk is looked up once a minute at most: the lookup runs before the greeting. */
const TRUNK_TTL_MS = 60_000
let trunkLookup: { at: number; id: Promise<string | null> } | null = null

function transferTrunk(sip: ReturnType<typeof sipClient>): Promise<string | null> {
  if (trunkLookup && Date.now() - trunkLookup.at < TRUNK_TTL_MS) return trunkLookup.id
  const id = findOutboundTrunk(sip, TRANSFER_TRUNK_NAME).catch(e => {
    console.warn(`could not look up the transfer trunk: ${e instanceof Error ? e.message : String(e)}`)
    trunkLookup = null
    return null
  })
  trunkLookup = { at: Date.now(), id }
  return id
}

/** A phone call test calls from CALL_TEST_FROM: it never puts anyone through to a real on-call phone. */
export const isPhoneCallTest = (
  call: Pick<CallSession, 'contact'>,
  env: Record<string, string | undefined> = process.env,
) => !!env.CALL_TEST_FROM && call.contact?.phone === env.CALL_TEST_FROM

/**
 * The live warm-transfer test's opt-in: with CALL_TEST_ONCALL set (the test on-call number, answered by
 * the on-call responder), a phone call test may be put through to exactly that number and no other.
 */
export const liveTransferTestAllows = (number: string, env: Record<string, string | undefined> = process.env) =>
  !!env.CALL_TEST_ONCALL && number === env.CALL_TEST_ONCALL

/**
 * Who picks up the transfer on this call: the simulated person in a no-phone call test, else the
 * on-call number through the "linedesk-outbound" trunk. null when there is no such trunk (run
 * `setup-sip --outbound`): then the assistant cannot transfer and takes a message.
 */
export async function onCallDialerFor(
  call: CallSession,
  number: string,
  config: AgentConfig,
  api: ApiClient,
): Promise<OnCallDialer | null> {
  if (call.simulatedOnCall) return simulatedDialer(call.simulatedOnCall, livekitOf(), config)
  if (!call.businessNumber) return null // a browser test call never dials a real phone
  if (number === call.businessNumber) {
    // It would ring straight back into this assistant (assistant.update refuses it; older settings may have it).
    console.warn(`transfer is on for call ${call.callId}, but the on-call number is the business's own Linedesk number`)
    return null
  }
  // Nor does a phone call test, except to the test on-call number when the live transfer test is on.
  if (isPhoneCallTest(call) && !liveTransferTestAllows(number)) return null
  const sip = sipClient()
  const from = call.businessNumber
  // A number in the workspace's own carrier account dials out through that account, never the install's.
  const route = await transferRoute(api, call.workspaceId, from).catch(e => {
    console.warn(`could not tell how call ${call.callId} transfers: ${e instanceof Error ? e.message : String(e)}`)
    return null
  })
  if (route === null) return null
  const { trunkName } = route
  if (route.carrier !== 'default' && trunkName) {
    return workspaceTrunkDialer(
      () => ownTransferTrunk(api, sip, call.workspaceId, trunkName, from),
      () => reprovisionTrunk(api, call.workspaceId),
      trunkId => sipDialer({ sip, trunkId, to: number, from }),
    )
  }
  const trunkId = await transferTrunk(sip)
  if (!trunkId) {
    console.warn(
      `transfer is on for call ${call.callId}, but there is no "${TRANSFER_TRUNK_NAME}" trunk: run setup-sip --outbound`,
    )
    return null
  }
  return sipDialer({ sip, trunkId, to: number, from: call.businessNumber })
}

const lines = createGreetingCache()

/** "I'm connecting you…" in the assistant's voice, mono; synthesized once per voice and kept like the greeting. */
async function connectingLine(config: AgentConfig, call: CallSession): Promise<Announcement> {
  const key = greetingKey({
    ...greetingVoice(config, call),
    text: CONNECTING_LINE,
  })
  let audio = await lines.get(key)
  if (!audio) {
    audio = await synthesize(createTts(config.tts, call.assistant?.voice), CONNECTING_LINE)
    void lines.put(key, audio).catch(() => {})
  }
  const { channels, samples } = audio
  return {
    sampleRate: audio.sampleRate,
    samples: channels === 1 ? samples : samples.filter((_, i) => i % channels === 0),
  }
}

type TransferToolDeps = {
  /** Stops the call's recording: the conversation with the on-call person is not recorded. */
  stopRecording?: () => Promise<void>
  ctx: JobContext
  api: ApiClient
  call: CallSession
  log: CallLog
  config: AgentConfig
  callerIdentity: string
  number: string
  dialer: OnCallDialer
}

/** Aborts when the caller leaves the room. */
function callerLeft(ctx: JobContext, identity: string): AbortSignal {
  const controller = new AbortController()
  const onLeft = (participant: RemoteParticipant) => {
    if (participant.identity !== identity) return
    ctx.room.off(RoomEvent.ParticipantDisconnected, onLeft)
    controller.abort()
  }
  ctx.room.on(RoomEvent.ParticipantDisconnected, onLeft)
  return controller.signal
}

/** Asks the API to start the transfer (call.transfer dialing): refused over the workspace's limits. */
async function startTransfer(api: ApiClient, call: CallSession, to: string): Promise<string | null> {
  try {
    await api.run(callTransfer, { callId: call.callId, to, result: 'dialing' }, call.workspaceId)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export function transferTool({
  ctx,
  api,
  call,
  log,
  config,
  callerIdentity,
  number,
  dialer,
  stopRecording,
}: TransferToolDeps) {
  let tried = false
  return llm.tool({
    description:
      "Put an urgent caller through to the business's on-call person. Only for an emergency that needs a person right now, once you know the caller's name and what happened. It tells the caller itself that you are connecting them: say nothing else in the same response.",
    parameters: z.object({
      caller_name: z.string().nullish().describe("The caller's name, if they gave it."),
      about: z.string().describe('What the emergency is, in a few words, e.g. "a burst pipe flooding the kitchen".'),
    }),
    execute: async ({ caller_name, about }, { ctx: run }) => {
      if (tried) return 'You already tried to transfer this call. Take a message instead.'
      tried = true
      const refused = await startTransfer(api, call, number)
      if (refused) {
        console.warn(`transfer of call ${call.callId} not started: ${refused}`)
        log.urgent = true
        log.record('system', transferLabel('failed', number), callTransfer.name)
        void api
          .run(callTransfer, { callId: call.callId, to: number, result: 'failed' }, call.workspaceId)
          .catch(() => {})
        return NOT_CONNECTED_REPLY
      }
      await run.waitForPlayout()
      run.disallowInterruptions()
      const session = run.session
      // The caller is on hold: what they say now is not a turn for the assistant.
      session.input.setAudioEnabled(false)
      // A fixed line, so the caller always hears what happens before the ringback (models often only call the tool).
      const announcement = await connectingLine(config, call).catch(e => {
        console.warn(`could not make the connecting line: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      })
      if (announcement) log.record('agent', CONNECTING_LINE)
      const briefing = briefingText({
        callerName: caller_name ?? call.contact?.name ?? null,
        callerNumber: call.contact?.phone ?? null,
        about,
      })
      const { result } = await warmTransfer(
        {
          livekit: livekitOf(),
          callerRoom: ctx.room,
          callerIdentity,
          dialer,
          config,
          voice: call.assistant?.voice,
          announcement,
        },
        briefing,
        callerLeft(ctx, callerIdentity),
        {
          onBridgeEnded: () => void ctx.deleteRoom().catch(() => {}),
          addCleanup: cleanup => ctx.addShutdownCallback(cleanup),
          onConnecting: stopRecording,
        },
      )
      log.urgent = true
      log.record('system', transferLabel(result, number), callTransfer.name)
      await api
        .run(callTransfer, { callId: call.callId, to: number, result }, call.workspaceId)
        .catch(e =>
          console.error(
            `could not record the transfer of call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
      if (result === 'connected') {
        // The caller and the on-call person talk now; the assistant stays out of it.
        log.transferred = true
        session.output.setAudioEnabled(false)
        return undefined
      }
      session.input.setAudioEnabled(true)
      return NOT_CONNECTED_REPLY
    },
  })
}
