// Test calls without a phone: the test caller and the business's assistant in one LiveKit room. Used by call-test
// and by the load test, which puts the test callers on a worker of their own (`callerAgent`).
import { callFindForTest, type CallTestFinding, VOICE_PIPELINE_LABELS, type VoicePipeline } from '@linedesk/actions'
import { AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import type { ApiClient } from '../api-client.ts'
import { AGENT_NAME, livekitHttpUrl, requireLivekitEnv } from '../env.ts'
import { type AgentSetup, LATENCY_ATTRIBUTE, type LatencySample, SETUP_ATTRIBUTE } from './latency.ts'
import { type Scenario, type ScenarioName, scenarios, type TestCallerMetadata } from './scenarios.ts'

export type RoomCall = {
  name: ScenarioName
  to: string
  room: string
  since: string
  api: ApiClient
  persona?: string | undefined
  pipeline?: VoicePipeline | undefined
  realtimeModel?: string | undefined
}

function roomService() {
  const livekit = requireLivekitEnv()
  return new RoomServiceClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
}

export function dispatcher() {
  const livekit = requireLivekitEnv()
  return new AgentDispatchClient(
    livekitHttpUrl(livekit.LIVEKIT_URL),
    livekit.LIVEKIT_API_KEY,
    livekit.LIVEKIT_API_SECRET,
  )
}

/**
 * Reads, while the room exists, the test caller's latency attribute and the business agent's setup
 * attribute; keeps the last value seen of each.
 */
export function latencyReader(room: string) {
  const rooms = roomService()
  let last: LatencySample | null = null
  let setup: AgentSetup | null = null
  return {
    get: () => last,
    setup: () => setup,
    async poll() {
      const participants = await rooms.listParticipants(room).catch(() => [])
      for (const p of participants) {
        const value = p.attributes[LATENCY_ATTRIBUTE]
        if (value) last = JSON.parse(value) as LatencySample
        const own = p.attributes[SETUP_ATTRIBUTE]
        if (own) setup = JSON.parse(own) as AgentSetup
      }
    },
  }
}

/** Polls until the test caller's room is empty (the call ended) or `deadline`, reading the latency on the way. */
export async function waitForCallEnd(room: string, deadline: number, poll: () => Promise<void>) {
  const rooms = roomService()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    await poll()
    if (!(await rooms.listParticipants(room).catch(() => [])).length) return
  }
}

/** Resolves once someone is in `room`; throws after `timeoutMs`. */
async function waitForParticipant(room: string, timeoutMs = 20_000) {
  const rooms = roomService()
  for (
    const deadline = Date.now() + timeoutMs;
    Date.now() < deadline;
    await new Promise(resolve => setTimeout(resolve, 100))
  ) {
    if ((await rooms.listParticipants(room).catch(() => [])).length) return
  }
  throw new Error(`the test caller did not join room ${room} within ${timeoutMs / 1000} s`)
}

/** Both agents in one room: the test caller (on `callerAgent`), and the business's as a test call of its workspace. */
export async function startInRoom(
  { name, room, to, since, api, persona, pipeline, realtimeModel }: RoomCall,
  callerAgent = AGENT_NAME,
) {
  const { workspaceId } = (await api.run(callFindForTest, { to, since, room })).data as CallTestFinding
  const dispatch = dispatcher()
  const caller: TestCallerMetadata = {
    source: 'test-caller',
    scenario: name,
    mode: 'room',
    ...(persona ? { persona } : {}),
  }
  const { businessHours, outsideGreeting, onCall, languages, mainLanguage, caller: played, behaviours } = scenarios[name] as Scenario
  const metadata = {
    source: 'test',
    workspaceId,
    ...(pipeline ? { pipeline } : {}),
    ...(realtimeModel ? { realtimeModel } : {}),
    ...(businessHours ? { businessHours } : {}),
    ...(outsideGreeting ? { outsideGreeting } : {}),
    ...(onCall ? { onCall } : {}),
    ...(languages ? { languages } : {}),
    ...(mainLanguage ? { mainLanguage } : {}),
    ...(played ? { caller: played } : {}),
    ...(behaviours ? { behaviours } : {}),
  }
  // The caller first, as on a phone call: the caller is in the room when the business's job starts,
  // so the business's own timing from its job start is not the time the test caller takes to join.
  await dispatch.createDispatch(room, callerAgent, { metadata: JSON.stringify(caller) })
  await waitForParticipant(room)
  await dispatch.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify(metadata) })
  console.log(
    `Test call in room ${room} with workspace ${workspaceId} (scenario ${name}, no phone${pipeline ? `, ${VOICE_PIPELINE_LABELS[pipeline].toLowerCase()}` : ''}${realtimeModel ? `, ${realtimeModel}` : ''})…`,
  )
}
