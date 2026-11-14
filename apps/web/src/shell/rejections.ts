// What the user reads when the server refuses an action: a plain sentence, never an action id.
import { phoneSetupErrorText } from '../onboarding/flow.ts'

const verbs: Record<string, string> = {
  'call.markDone': 'mark the call done',
  'call.markNotDone': 'reopen the call',
  'call.markRead': 'mark the call read',
  'call.markUnread': 'mark the call unread',
  'call.remind': 'set the reminder',
  'call.clearReminder': 'clear the reminder',
  'call.delete': 'delete the call',
  'call.restore': 'restore the call',
  'call.setActionItems': 'update the next steps',
  'contact.update': 'save the contact',
  'assistant.update': 'save the assistant settings',
  'onboarding.setStep': 'save your setup progress',
  'onboarding.recordEvent': 'save your setup progress',
  'phoneNumber.release': 'release the number',
  'notifications.update': 'save your notification settings',
  'notifications.setDefaults': 'save the notification defaults',
  'workspace.updateSettings': 'save the workspace settings',
  'workspace.rename': 'rename the business',
  'workspace.setIcon': 'save the workspace icon',
  'workspace.removeIcon': 'remove the workspace icon',
  'businessHours.set': 'save the business hours',
  'phoneNumber.update': 'change the number',
  'push.subscribe': 'turn on notifications on this device',
  'push.unsubscribe': 'turn off notifications on this device',
  'appointmentType.upsert': 'save the appointment type',
  'appointmentType.delete': 'remove the appointment type',
  'sample.add': 'add the sample calls',
  'sample.remove': 'remove the sample calls',
  'onboarding.dismissGoLiveChecklist': 'hide the go-live checklist',
  'onboarding.reopenGoLiveChecklist': 'show the go-live checklist',
  'onboarding.skipGoLiveStep': 'mark that step not needed',
  'onboarding.remindGoLiveStep': 'set the reminder',
  'onboarding.restoreGoLiveStep': 'bring that step back',
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
    return "The server can't be reached. Check your connection and try again."
  if (!t || /^HTTP \d{3}$|internal server error|^[[{<]|\n\s*at |\bundefined\b|\bnull\b/i.test(t) || t.length > 240)
    return 'Something went wrong on the server. Try again in a moment.'
  return sentence(t)
}

export function rejectionText(action: string, error: string): string {
  if (action === 'phoneNumber.setup') return phoneSetupErrorText(error)
  if (action in forwardingFallback) return forwardingCheckErrorText(action, error)
  return `Could not ${verbs[action] ?? 'save that change'}. ${rejectionReason(error)}`.trim()
}

// The forwarding check (phoneNumber.checkForwarding, phoneNumber.lookupLine): the server's sentences written for the
// owner (limits, a number it cannot call) pass as they are; its internal reasons get words; anything else the fallback.
const forwardingFallback: Record<string, string> = {
  'phoneNumber.checkForwarding': 'The check could not start. Try again in a moment.',
  'phoneNumber.lookupLine': 'Your carrier could not be looked up. Pick it from the list.',
}
const forwardingWritten =
  /^(Enter |That is |That number was checked|A check is already running|Too many |You checked |Forwarding checks are paused|Lookups are paused|The line could not be looked up|No connection to the server)/
const forwardingReasons: [RegExp, string][] = [
  [/workspace is disabled/i, 'This workspace is disabled, so nothing can be checked.'],
  [/not found/i, 'This number is no longer connected to your workspace.'],
  [/only a number your business phone forwards to/i, 'Only a number your business phone forwards to can be checked.'],
]

function forwardingCheckErrorText(action: string, error: string): string {
  const t = error.trim()
  if (forwardingWritten.test(t)) return t
  return forwardingReasons.find(([re]) => re.test(t))?.[1] ?? forwardingFallback[action]!
}
