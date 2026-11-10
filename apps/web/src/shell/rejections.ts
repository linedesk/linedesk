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
  'notifications.update': 'save your notification settings',
  'notifications.setDefaults': 'save the notification defaults',
  'workspace.updateSettings': 'save the workspace settings',
}

const sentence = (text: string) => {
  const t = text.trim()
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : ''
}

export function rejectionText(action: string, error: string): string {
  if (action === 'phoneNumber.setup') return phoneSetupErrorText(error)
  return `Could not ${verbs[action] ?? 'do that'}. ${sentence(error)}`.trim()
}
