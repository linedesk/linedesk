// The assistant's transfer_call tool: puts the caller through to the transfer contact whose condition
// fits (warm transfer, transfer-call.ts), tries the next one when the contact says so, and records how
// each try went with call.transfer.
import { callTakeMessage, callTransfer, type TransferResult } from '@linedesk/actions'
import { llm, type JobContext } from '@livekit/agents'
import { type RemoteParticipant, RoomEvent } from '@livekit/rtc-node'
import { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import type { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import type { AgentConfig } from './config.ts'
import type { Announcement } from './audio-bridge.ts'
import { requireLivekitEnv } from './env.ts'
import { lineAudio } from './busy-line.ts'
import { type OnCallDialer, simulatedDialer, sipDialer } from './on-call-dialer.ts'
import { findOutboundTrunk, sipClient, TRANSFER_TRUNK_NAME } from './sip-trunks.ts'
import { ownTransferTrunk, reprovisionTrunk, transferRoute, workspaceTrunkDialer } from './workspace-trunk.ts'
import {
  briefingText,
  connectingLine as connectingText,
  type Dialable,
  notConnectedMessage,
  notConnectedReply,
  transferLabel,
  transferPlan,
  tryingNextLine,
} from './transfer.ts'
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
 * contact's number through the "linedesk-outbound" trunk. null when there is no such trunk (run
 * `setup-sip --outbound`): then the assistant cannot transfer and takes a message.
 */
export async function onCallDialerFor(
  call: CallSession,
  number: string,
  config: AgentConfig,
  api: ApiClient,
): Promise<OnCallDialer | null> {
  if (call.simulatedOnCall) return simulatedDialer(call.simulatedOnCall, livekitOf(), config, call.simulatedOnCallLine)
  if (!call.businessNumber) return null // a test call never dials a real phone
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
  const route = await transferRoute(api, call, from).catch(e => {
    console.warn(`could not tell how call ${call.callId} transfers: ${e instanceof Error ? e.message : String(e)}`)
    return null
  })
  if (route === null) return null
  const { trunkName } = route
  if (route.carrier !== 'default' && trunkName) {
    return workspaceTrunkDialer(
      () => ownTransferTrunk(api, sip, call, trunkName, from),
      () => reprovisionTrunk(api, call),
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

/** A fixed line in the assistant's voice, mono; made once per voice and text and kept like the greeting. */
async function connectingLine(config: AgentConfig, call: CallSession, text: string): Promise<Announcement> {
  const audio = await lineAudio(config, call, text)
  const { channels, samples } = audio
  return {
    sampleRate: audio.sampleRate,
    samples: channels === 1 ? samples : samples.filter((_, i) => i % channels === 0),
  }
}

type TransferToolDeps = {
  /** Stops the call's recording: the conversation with the person put through is not recorded. */
  stopRecording?: () => Promise<void>
  ctx: JobContext
  api: ApiClient
  call: CallSession
  log: CallLog
  config: AgentConfig
  /** The caller in the room; on a phone call they are there from the start. */
  callerIdentity: Promise<string>
  /** The contacts that take calls now (transferContactsFor), in the owner's order. */
  contacts: Dialable[]
  /** How to dial a contact, looked up when the call starts; null: it cannot be dialled on this call. */
  dialerOf: (contact: Dialable) => Promise<OnCallDialer | null>
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

type Report = { to: string; name: string }

/** The team's to-do when nobody took the call (call.takeMessage); a failure is logged, the call goes on. */
async function saveNotConnectedMessage(api: ApiClient, call: CallSession, log: CallLog, message: string) {
  try {
    await api.run(callTakeMessage, { callId: call.callId, message }, call)
    log.messages.push(message)
    log.record('system', 'Took a message', callTakeMessage.name)
  } catch (e) {
    console.error(`could not save the message for call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Records a try's result with call.transfer (`dialing` asks to start it; refused over the workspace's limits). */
async function report(api: ApiClient, call: CallSession, { to, name }: Report, result: TransferResult) {
  await api.run(callTransfer, { callId: call.callId, to, name, result }, call)
}

/** Why the API refused to start the transfer, or null when it may go ahead. */
async function startTransfer(api: ApiClient, call: CallSession, target: Report): Promise<string | null> {
  try {
    await report(api, call, target, 'dialing')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** The tool's description: every contact with when to put the caller through to them. */
export function transferToolDescription(contacts: readonly Pick<Dialable, 'name' | 'condition'>[]): string {
  const list = contacts.map(c => `"${c.name}": ${c.condition}`).join('; ')
  return `Put the caller through to a person. The contacts, with when each one takes calls: ${list}. Use it only when a contact's condition fits the call, once you know the caller's name and what they need; contacts with the same condition are tried in the owner's order by themselves. It tells the caller itself that you are trying to reach them: say nothing else in the same response.`
}

/**
 * transfer_call, given from the start of the call: nothing is dialled until the assistant uses it, once a contact's
 * condition fits. A contact that cannot be dialled counts as not answered: the next one is tried only when its
 * "if nobody accepts" says so (transferPlan), else the assistant takes a message.
 */
export function transferTool({ ctx, api, call, log, config, callerIdentity, contacts, dialerOf, stopRecording }: TransferToolDeps) {
  let tried = false
  const names = contacts.map(c => c.name) as [string, ...string[]]
  return llm.tool({
    description: transferToolDescription(contacts),
    parameters: z.object({
      contacts: z
        .array(z.enum(names))
        .min(1)
        .describe('Every contact whose condition fits this call, by name.'),
      caller_name: z.string().nullish().describe("The caller's name, if they gave it."),
      about: z.string().describe('What the call is about, in a few words, e.g. "a question about an open invoice".'),
    }),
    execute: async ({ contacts: picked, caller_name, about }, { ctx: run }) => {
      if (tried) return 'You already tried to transfer this call. Take a message instead.'
      const plan = transferPlan(contacts, picked)
      if (!plan) return 'None of those is one of the contacts. Only transfer when a contact fits; else take a message.'
      tried = true
      // The caller is on hold until this returns: no silence reminders and no collection steps meanwhile.
      log.onHold = true
      await run.waitForPlayout()
      run.disallowInterruptions()
      const session = run.session
      // The caller is on hold: what they say now is not a turn for the assistant.
      session.input.setAudioEnabled(false)
      const caller = await callerIdentity
      const left = callerLeft(ctx, caller)
      // The name the caller confirmed on this call beats the one on file (a shared or test number has someone else's).
      const callerName = caller_name ?? log.confirmedName ?? call.contact?.name ?? null
      const briefing = briefingText({
        callerName,
        callerNumber: call.contact?.phone ?? null,
        about,
      })
      let previous: Dialable | null = null
      const triedNames: string[] = []
      for (const [i, contact] of plan.tries.entries()) {
        const target = { to: contact.number, name: contact.name }
        triedNames.push(contact.name) // also when refused: the caller wanted a person and got none
        const dialer = await dialerOf(contact)
        if (!dialer) {
          // No way to dial it on this call (no outbound trunk, a test call): like no answer, the plan decides what is next.
          console.warn(`transfer of call ${call.callId}: ${contact.name} cannot be dialled on this call`)
          log.record('system', transferLabel('failed', contact.number, contact.name), callTransfer.name)
          void report(api, call, target, 'failed').catch(() => {})
          previous = contact
          continue
        }
        const refused = await startTransfer(api, call, target)
        if (refused) {
          console.warn(`transfer of call ${call.callId} not started: ${refused}`)
          log.record('system', transferLabel('failed', contact.number, contact.name), callTransfer.name)
          void report(api, call, target, 'failed').catch(() => {})
          break // the workspace's limits: the next contact would be refused too
        }
        // A fixed line, so the caller always hears whom they are put through to before the ringback.
        const text = previous ? tryingNextLine(previous.name, contact.name) : connectingText(contact.name)
        const announcement = await connectingLine(config, call, text).catch(e => {
          console.warn(`could not make the connecting line: ${e instanceof Error ? e.message : String(e)}`)
          return undefined
        })
        if (announcement) log.record('agent', text)
        const { result } = await warmTransfer(
          {
            livekit: livekitOf(),
            callerRoom: ctx.room,
            callerIdentity: caller,
            dialer,
            config,
            voice: call.assistant?.voice,
            announcement,
            ringSeconds: contact.ring_seconds,
            attempt: i + 1,
          },
          briefing,
          left,
          {
            onBridgeEnded: () => void ctx.deleteRoom().catch(() => {}),
            addCleanup: cleanup => ctx.addShutdownCallback(cleanup),
            onConnecting: stopRecording,
          },
        )
        log.record('system', transferLabel(result, contact.number, contact.name), callTransfer.name)
        await report(api, call, target, result).catch(e =>
          console.error(
            `could not record the transfer of call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
        if (result === 'connected') {
          // The caller and the person talk now; the assistant stays out of it.
          log.transferred = true
          log.onHold = false
          session.output.setAudioEnabled(false)
          return undefined
        }
        if (left.aborted) break
        previous = contact
      }
      if (triedNames.length) await saveNotConnectedMessage(api, call, log, notConnectedMessage({ callerName, about, tried: triedNames }))
      session.input.setAudioEnabled(true)
      log.onHold = false
      return notConnectedReply()
    },
  })
}
