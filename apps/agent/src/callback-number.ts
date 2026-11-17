// The number the owner calls back on. With caller ID it is the number the caller is calling from: the owner has it with
// the call, and the assistant only asks whether it is the best one to reach them; the phone step is only for another
// number the caller wants (on realtime calls it asked for a number although caller ID was known, and saved the one the
// caller made up, LIN-99; LIN-386). Without caller ID it counts once get_phone_number confirmed it.
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
