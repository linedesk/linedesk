// What Workspace settings › Danger zone says before an owner deletes the workspace (DangerZone.tsx), as plain
// functions of the server's preview (workspace.deletePreview), so the words are tested without a browser.
import type { WorkspaceDeletePreviewData } from '@linedesk/actions'
import type { DangerConfirmation } from '../ui/DangerConfirmDialog.tsx'

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** One line per kind of data that goes, in the order the admin's delete lists them (admin/actions.tsx). */
export function deleteOwnList(p: WorkspaceDeletePreviewData, brand: string): string[] {
  const { bought, attached } = p.numbers
  const numbers = !bought && !attached ? [count(0, 'phone number')] : []
  if (bought) numbers.push(`${count(bought, 'phone number')} bought through ${brand}: released at the carrier`)
  if (attached)
    numbers.push(
      `${count(attached, 'phone number')} you brought or connected: ${attached === 1 ? 'it stops' : 'they stop'} reaching ${brand} and ${attached === 1 ? 'stays' : 'stay'} yours`,
    )
  return [
    `${count(p.calls, 'call')}, with their transcripts and recordings`,
    count(p.contacts, 'contact'),
    ...numbers,
    'Its bookings, settings and invitations',
    ...(p.otherMembers
      ? [`The access of ${count(p.otherMembers, 'other member')}; each of them gets an email that it was deleted`]
      : []),
    ...(p.accountsDeleted
      ? [
          `${count(p.accountsDeleted, 'account')} will be deleted because ${p.accountsDeleted === 1 ? 'it has' : 'they have'} no other workspace`,
        ]
      : []),
  ]
}

/** The dialog's words; the "Keep my account" box only when the owner's own account would go. */
export function deleteOwnConfirmation(p: WorkspaceDeletePreviewData, brand: string): DangerConfirmation {
  return {
    text: `This deletes ${p.name} and all its data for good.`,
    list: deleteOwnList(p, brand),
    after: 'This cannot be undone.',
    action: 'Delete workspace',
    busyAction: 'Deleting…',
    typed: p.name,
    option: p.ownAccountDeleted ? 'Keep my account' : undefined,
  }
}

/** The separate warning about the owner's own account (DangerZone.tsx): null when it stays anyway. */
export function ownAccountWarning(p: Pick<WorkspaceDeletePreviewData, 'ownAccountDeleted'>, keep: boolean) {
  if (!p.ownAccountDeleted) return null
  return keep
    ? {
        tone: 'neutral' as const,
        title: 'Your account stays.',
        text: 'You land on the page to set up or join another workspace.',
      }
    : {
        tone: 'danger' as const,
        title: 'Your own account will be deleted too.',
        text: "You have no other workspace, so your account goes with this one. You'll be signed out and can't sign in again.",
      }
}

const REOPEN_KEY = 'linedesk.reopenDeleteWorkspace'

/** Before "Sign in again" from the dialog: after the sign-in, the Danger zone of this workspace opens it again. */
export function reopenAfterSignIn(workspaceId: string) {
  try {
    sessionStorage.setItem(REOPEN_KEY, workspaceId)
  } catch {}
}

/** Whether the dialog should open again in this workspace (once; reopenAfterSignIn). */
export function takeReopen(workspaceId: string): boolean {
  try {
    const wanted = sessionStorage.getItem(REOPEN_KEY)
    if (wanted) sessionStorage.removeItem(REOPEN_KEY)
    return wanted === workspaceId
  } catch {
    return false
  }
}
