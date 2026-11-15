// The number the team calls back on. With caller ID it is the number the caller is calling from: the team has it with
// the call, and the assistant does not ask for one. A different number counts only once get_phone_number confirmed it,
// asked for with a reason (the caller wants to be called back elsewhere). On realtime calls the assistant asked for a
// number although caller ID was known, and saved the one the caller made up (LIN-99).
import { isE164 } from '@linedesk/actions'
import { toE164 } from './collect/collectors.ts'

/** The caller's number from caller ID, or null: withheld, not a phone number ("anonymous"), or a test call from the web app. */
export const callerIdOf = (call: { contact?: { phone?: string | null } | null }): string | null => {
  const phone = call.contact?.phone
  return isE164(phone) ? phone : null
}

/**
 * Every whole phone number in a text, as E.164, read as numbers are written in `country` (the workspace's). Short
 * numbers (a ZIP, a time, a price) do not count.
 */
export function phoneNumbersIn(text: string, country = 'US'): string[] {
  const found: string[] = []
  for (const [match] of text.matchAll(/\+?\d[\d\s().-]{4,}\d/g)) {
    const parsed = toE164(match, country)
    if (parsed.ok && !found.includes(parsed.value)) found.push(parsed.value)
  }
  return found
}

/**
 * Whether the team has a number to call the caller back on: caller ID, a number the caller confirmed with
 * get_phone_number, or one in a message saved on the call. Without one the summary asks for no call back.
 */
export function hasCallbackNumber(
  callerId: string | null,
  { confirmed, saved, country = 'US' }: { confirmed: readonly string[]; saved: readonly string[]; country?: string },
): boolean {
  return !!callerId || confirmed.length > 0 || saved.some(text => phoneNumbersIn(text, country).length > 0)
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
  return `The caller is calling from ${callerId} (caller ID), and the team has that number as the callback number: do not ask for one. Use get_phone_number for a callback number only when the caller said they want to be called back on a different number, and give that as the reason.`
}
