// The number the team calls back on. With caller ID it is the number the caller is calling from: take_message saves it
// with the message by itself, and the assistant does not ask for one. A different number goes in only once get_phone_number
// confirmed it, asked for with a reason (the caller wants to be called back elsewhere). On realtime calls the assistant
// asked for a number although caller ID was known, and saved the one the caller made up (LIN-99).
import { isE164 } from '@linedesk/actions'
import { toE164 } from './collect/collectors.ts'

/** The caller's number from caller ID, or null: withheld, not a phone number ("anonymous"), or a test call from the web app. */
export const callerIdOf = (call: { contact?: { phone?: string | null } | null }): string | null => {
  const phone = call.contact?.phone
  return isE164(phone) ? phone : null
}

/** Every whole phone number in a text, as E.164. Short numbers (a ZIP, a time, a price) do not count. */
export function phoneNumbersIn(text: string): string[] {
  const found: string[] = []
  for (const [match] of text.matchAll(/\+?\d[\d\s().-]{4,}\d/g)) {
    const parsed = toE164(match)
    if (parsed.ok && !found.includes(parsed.value)) found.push(parsed.value)
  }
  return found
}

/** The longest message call.takeMessage takes. */
const MESSAGE_MAX = 500

/** What take_message does with a message: save `text`, or tell the assistant `refusal` instead. */
export type CallbackCheck = { text: string } | { refusal: string }

/**
 * A message as it is saved. With caller ID: a number in it other than caller ID that get_phone_number did not confirm is
 * refused (the assistant asks for it with a reason, or leaves it out); without any number in it, the caller ID is added as
 * the callback number, once per call and only when the caller confirmed no other number. Without caller ID the message
 * is saved as it is.
 */
export function withCallbackNumber(
  message: string,
  callerId: string | null,
  { confirmed, saved }: { confirmed: readonly string[]; saved: readonly string[] },
): CallbackCheck {
  if (!callerId) return { text: message }
  const numbers = phoneNumbersIn(message)
  const unconfirmed = numbers.filter(number => number !== callerId && !confirmed.includes(number))
  if (unconfirmed.length) {
    return {
      refusal: `${unconfirmed[0]} is not the caller's number and was not confirmed with get_phone_number. The caller's own number (${callerId}, caller ID) is saved as the callback number by itself. Call take_message again without that number; only if the caller said they want to be called back on a different number, get it with get_phone_number first, giving their reason.`,
    }
  }
  // A number in this message or an earlier one, or one the caller confirmed (meant for the team): caller ID is not added.
  const callbackSaved =
    numbers.length > 0 || confirmed.length > 0 || saved.some(text => phoneNumbersIn(text).length > 0)
  const line = ` Callback number: ${callerId} (caller ID).`
  if (callbackSaved || message.length + line.length > MESSAGE_MAX) return { text: message }
  return { text: message.trimEnd() + line }
}

/**
 * Why get_phone_number does not ask: with caller ID, a callback number is only asked for when the caller wants another
 * one, and the assistant says why. null: it may ask.
 */
export function phoneStepRefusal(
  callerId: string | null,
  what: string,
  reason: string | null | undefined,
): string | null {
  if (!callerId || reason?.trim() || !/callback|call back|call-back/i.test(what)) return null
  return `The caller is calling from ${callerId} (caller ID), and that number is saved as the callback number by itself: do not ask for one. Use get_phone_number for a callback number only when the caller said they want to be called back on a different number, and give that as the reason.`
}
