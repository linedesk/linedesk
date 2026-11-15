// What the user reads when the server refuses an action: a plain sentence, never an action id.
import { phoneSetupErrorText } from '../onboarding/flow.ts'
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
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(t))
    return i18n().t('errors.unreachable')
  if (!t || /^HTTP \d{3}$|internal server error|^[[{<]|\n\s*at |\bundefined\b|\bnull\b/i.test(t) || t.length > 240)
    return i18n().t('errors.server')
  return sentence(t)
}

export function rejectionText(action: string, error: string): string {
  if (action === 'phoneNumber.setup') return phoneSetupErrorText(error)
  if (action in forwardingFallback) return forwardingCheckErrorText(action, error)
  const couldNot = i18n().t((verbs[action] ?? 'errors.couldNot.default') as MessageKey)
  return `${couldNot} ${rejectionReason(error)}`.trim()
}

// The forwarding check (phoneNumber.checkForwarding, phoneNumber.lookupLine): the server's sentences written for the
// owner (limits, a number it cannot call) pass as they are; its internal reasons get words; anything else the fallback.
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

function forwardingCheckErrorText(action: string, error: string): string {
  const t = error.trim()
  if (forwardingWritten.test(t)) return t
  return i18n().t(forwardingReasons.find(([re]) => re.test(t))?.[1] ?? forwardingFallback[action]!)
}
