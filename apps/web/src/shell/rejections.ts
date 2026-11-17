// What the user reads when the server refuses an action: a plain sentence, never an action id.
import { phoneSetupErrorText } from '../onboarding/flow.ts'
import { FORWARDING_REFUSED } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { i18n } from '../i18n/index.tsx'

// i18n-dynamic: errors.couldNot.*
const verbs: Record<string, string> = {
  'call.markDone': 'errors.couldNot.call.markDone',
  'call.markNotDone': 'errors.couldNot.call.markNotDone',
  'call.markRead': 'errors.couldNot.call.markRead',
  'call.markUnread': 'errors.couldNot.call.markUnread',
  'call.remind': 'errors.couldNot.call.remind',
  'call.clearReminder': 'errors.couldNot.call.clearReminder',
  'call.delete': 'errors.couldNot.call.delete',
  'call.restore': 'errors.couldNot.call.restore',
  'call.setActionItems': 'errors.couldNot.call.setActionItems',
  'contact.update': 'errors.couldNot.contact.update',
  'assistant.update': 'errors.couldNot.assistant.update',
  'onboarding.setStep': 'errors.couldNot.onboarding.setStep',
  'onboarding.recordEvent': 'errors.couldNot.onboarding.recordEvent',
  'phoneNumber.release': 'errors.couldNot.phoneNumber.release',
  'notifications.update': 'errors.couldNot.notifications.update',
  'notifications.setDefaults': 'errors.couldNot.notifications.setDefaults',
  'workspace.updateSettings': 'errors.couldNot.workspace.updateSettings',
  'workspace.rename': 'errors.couldNot.workspace.rename',
  'workspace.setAllowPremium': 'errors.couldNot.workspace.setAllowPremium',
  'workspace.setAllowUltra': 'errors.couldNot.workspace.setAllowUltra',
  'workspace.setIcon': 'errors.couldNot.workspace.setIcon',
  'workspace.removeIcon': 'errors.couldNot.workspace.removeIcon',
  'businessHours.set': 'errors.couldNot.businessHours.set',
  'phoneNumber.update': 'errors.couldNot.phoneNumber.update',
  'push.subscribe': 'errors.couldNot.push.subscribe',
  'push.unsubscribe': 'errors.couldNot.push.unsubscribe',
  'appointmentType.upsert': 'errors.couldNot.appointmentType.upsert',
  'appointmentType.delete': 'errors.couldNot.appointmentType.delete',
  'sample.add': 'errors.couldNot.sample.add',
  'sample.remove': 'errors.couldNot.sample.remove',
  'onboarding.dismissGoLiveChecklist': 'errors.couldNot.onboarding.dismissGoLiveChecklist',
  'onboarding.reopenGoLiveChecklist': 'errors.couldNot.onboarding.reopenGoLiveChecklist',
  'onboarding.skipGoLiveStep': 'errors.couldNot.onboarding.skipGoLiveStep',
  'onboarding.remindGoLiveStep': 'errors.couldNot.onboarding.remindGoLiveStep',
  'onboarding.restoreGoLiveStep': 'errors.couldNot.onboarding.restoreGoLiveStep',
}

/** The browser's words for a request that never reached the server. */
const OFFLINE = /failed to fetch|networkerror|load failed|network request failed/i

const sentence = (text: string) => {
  const t = text.trim()
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : ''
}

/**
 * The server's reason in words a person can act on. Reasons written for people pass through as a sentence; what is
 * not (no connection, a server error, raw data or a stack) becomes a plain line that says what to do.
 */
export function rejectionReason(error: string): string {
  const t = error.trim()
  if (OFFLINE.test(t)) return i18n().t('errors.unreachable')
  if (!t || /^HTTP \d{3}$|internal server error|^[[{<]|\n\s*at |\bundefined\b|\bnull\b/i.test(t) || t.length > 240)
    return i18n().t('errors.server')
  return sentence(t)
}

export function rejectionText(action: string, error: string, code?: string): string {
  if (action === 'phoneNumber.setup') return phoneSetupErrorText(error)
  if (action in forwardingFallback) return forwardingCheckErrorText(action, error, code)
  const couldNot = i18n().t((verbs[action] ?? 'errors.couldNot.default') as MessageKey)
  return `${couldNot} ${rejectionReason(error)}`.trim()
}

/** The code a refusal came with (runDirect puts it on the error), else undefined. */
export const codeOf = (e: unknown): string | undefined =>
  typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : undefined

// The forwarding check (phoneNumber.checkForwarding, phoneNumber.lookupLine): the server's sentences written for the
// owner (limits, a number it cannot call) pass as they are: in the reader's language with FORWARDING_REFUSED, else
// the English ones of the number policy; its internal reasons get words; anything else the fallback.
const forwardingFallback: Record<string, MessageKey> = {
  'phoneNumber.checkForwarding': msg('errors.forwarding.checkFailed'),
  'phoneNumber.lookupLine': msg('errors.forwarding.lookupFailed'),
}
const forwardingWritten =
  /^(Enter |That is |That number was checked|A check is already running|Too many |You checked |Forwarding checks are paused|Lookups are paused|The line could not be looked up|No connection to the server)/
const forwardingReasons: [RegExp, MessageKey][] = [
  [/workspace is disabled/i, msg('errors.forwarding.disabled')],
  [/not found/i, msg('errors.forwarding.notFound')],
  [/only a number your business phone forwards to/i, msg('errors.forwarding.notForwarded')],
]

function forwardingCheckErrorText(action: string, error: string, code?: string): string {
  const t = error.trim()
  if (code === FORWARDING_REFUSED && t) return t
  // The app's own offline line (errors.unreachable, in the reader's language: retry.ts, settings-api.ts) as it is, only
  // that exact sentence; the browser's raw network failure becomes it.
  if (forwardingWritten.test(t) || t === i18n().t('errors.unreachable')) return t
  if (OFFLINE.test(t)) return i18n().t('errors.unreachable')
  return i18n().t(forwardingReasons.find(([re]) => re.test(t))?.[1] ?? forwardingFallback[action]!)
}
