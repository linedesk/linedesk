// Where the time from a call's job start to its greeting goes (LIN-262). One log line per call, also published on the
// agent's participant, where the call test reads it.
//
// On a phone call LiveKit SIP keeps the line ringing until it subscribes to an audio track in the room, which is the
// agent's own (published when the session starts), and answers the call then. The agent holds its audio until that
// subscription, so "audio subscribed" is the pickup the caller hears, and the greeting can only start after it.
import { type Room, RoomEvent, TrackKind } from '@livekit/rtc-node'
import type { AgentSetup } from './test-caller/latency.ts'
import { SETUP_ATTRIBUTE } from './test-caller/latency.ts'

/** The step at which the greeting's first audio goes out. */
export const GREETING_STEP = 'greeting audio'
/** The step at which someone subscribed to the agent's audio: LiveKit SIP on a phone call, which answers it then. */
export const SUBSCRIBED_STEP = 'audio subscribed'

/** From the pickup (the agent's audio subscribed) to the greeting's first audio; null when either is missing. */
export function greetingAfterPickup(steps: Record<string, number>): number | null {
  const pickup = steps[SUBSCRIBED_STEP]
  const greeting = steps[GREETING_STEP]
  return pickup === undefined || greeting === undefined ? null : Math.max(0, greeting - pickup)
}

/** The steps in the order they happened. */
export const inOrder = (steps: Record<string, number>) => Object.entries(steps).sort(([, a], [, b]) => a - b)

/** The setup log line of one call. */
export function describeSetup(
  callId: string,
  startedAt: number,
  processWait: string | null,
  steps: Record<string, number>,
  detail: string,
): string {
  const marks = inOrder(steps).map(([step, ms]) => `${step} +${ms} ms`)
  const wait = processWait ? ` (${processWait})` : ''
  const after = greetingAfterPickup(steps)
  const pickup = after === null ? '' : `; greeting ${after} ms after the audio was subscribed (phone: pickup)`
  return `setup ${callId}: job started ${new Date(startedAt).toISOString()}${wait}, ${marks.join(', ')}${detail ? ` (greeting ${detail})` : ''}${pickup}`
}

/** Times from the job's start to each setup step, logged once per call with the wall-clock start. */
export type SetupTimer = ReturnType<typeof setupTimer>
export function setupTimer(processWait: string | null, startedAt = Date.now(), now: () => number = Date.now) {
  const steps: Record<string, number> = {}
  let detail = ''
  return {
    /** The first time of a step counts: a step marked again later keeps it. */
    mark(step: string) {
      steps[step] ??= now() - startedAt
    },
    note(text: string) {
      detail = text
    },
    /** Logs the timings and publishes them on the agent's participant, where the call test reads them. */
    log(callId: string, room?: Room) {
      console.log(describeSetup(callId, startedAt, processWait, steps, detail))
      const setup: AgentSetup = { steps: { ...steps }, greeting: detail }
      void room?.localParticipant?.setAttributes({ [SETUP_ATTRIBUTE]: JSON.stringify(setup) }).catch(() => {})
    },
  }
}

type SetupRoom = Pick<Room, 'on' | 'off'>

/**
 * Marks when the agent's audio track is published and when someone subscribes to it (on a phone call: LiveKit SIP,
 * which answers the call then). Returns a function that stops watching.
 */
export function watchAgentAudio(room: SetupRoom, mark: (step: string) => void): () => void {
  const published = (publication: { kind?: TrackKind }) => {
    if (publication.kind === TrackKind.KIND_AUDIO) mark('audio published')
  }
  const subscribed = (track: { kind?: TrackKind }) => {
    if (track.kind === TrackKind.KIND_AUDIO) mark(SUBSCRIBED_STEP)
  }
  room.on(RoomEvent.LocalTrackPublished, published)
  room.on(RoomEvent.LocalTrackSubscribed, subscribed)
  return () => {
    room.off(RoomEvent.LocalTrackPublished, published)
    room.off(RoomEvent.LocalTrackSubscribed, subscribed)
  }
}
