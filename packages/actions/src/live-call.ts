// Listening in to a live call and taking it over from the web app. Both only sign a short-lived
// LiveKit token for the call's room; the token itself decides what the browser may do there.
// Read-only for the action runner: the token must not be kept in the command log. What a member did
// is recorded as the call's activity (call_events) by the handler instead.
import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * Participant attribute on the member who takes a call over: their name, as the caller hears it. Set in the
 * token the API signs (a participant cannot change its own attributes), so the voice agent can trust it.
 */
export const TAKE_OVER_ATTRIBUTE = 'linedesk.takeOver'
/**
 * Attribute the voice agent sets on itself once it handed the call to the member (`ready`), or when it could
 * not (`refused`: the recording could not be stopped). The browser turns its microphone on only on `ready`.
 */
export const HAND_OFF_ATTRIBUTE = 'linedesk.handOff'
export type HandOff = 'ready' | 'refused'

const callId = z.object({ callId: z.string().min(1) })

export const callListen = defineAction({
  name: 'call.listen',
  description:
    "Listen in to a live call in the browser: returns a short-lived LiveKit token that can only hear the call's room, never speak.",
  input: callId,
  permission: 'call:write',
  readOnly: true,
})

export const callTakeOver = defineAction({
  name: 'call.takeOver',
  description:
    "Take a live call over from the assistant in the browser: returns a short-lived LiveKit token that may speak in the call's room. The assistant tells the caller who takes over and leaves the conversation.",
  input: callId,
  permission: 'call:write',
  readOnly: true,
})

/** `data` of `call.listen` and `call.takeOver`: where and how the browser joins. The token can join only `room`. */
export type LiveCallJoin = { url: string; token: string; room: string; identity: string; expiresAt: string }
