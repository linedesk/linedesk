// What Workspace settings › Danger zone says before an owner deletes the workspace (DangerZone.tsx), as plain
// functions of the server's preview (workspace.deletePreview), so the words are tested without a browser.
import type { WorkspaceDeletePreviewData } from '@linedesk/actions'
import type { DangerConfirmation } from '../ui/DangerConfirmDialog.tsx'

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * What deleting a workspace takes with it, one line per kind of data: the one list for an owner (Danger zone) and a
 * server admin (admin/actions.tsx). `numbers`: the phone number lines, which differ (the owner's preview knows which
 * were bought); `otherMembers`: the members besides the one deleting it, who each get an email; `accountsDeleted`:
 * the accounts that go because they have no other workspace.
 */
export type WorkspaceDeleteFacts = {
  calls: number
  contacts: number
  numbers: string[]
  otherMembers: number
  accountsDeleted: number
}

export function workspaceDeleteList(f: WorkspaceDeleteFacts): string[] {
  return [
    `${count(f.calls, 'call')}, with their transcripts and recordings`,
    count(f.contacts, 'contact'),
    ...f.numbers,
    'Its bookings, settings and invitations',
    ...(f.otherMembers
      ? [`The access of ${count(f.otherMembers, 'other member')}; each of them gets an email that it was deleted`]
      : []),
    ...(f.accountsDeleted
      ? [
          `${count(f.accountsDeleted, 'account')} will be deleted because ${f.accountsDeleted === 1 ? 'it has' : 'they have'} no other workspace`,
        ]
      : []),
  ]
}

/** The phone number lines when nothing is known but how many there are (a server admin's delete). */
export function numberLines(numbers: number, brand: string): string[] {
  return [
    numbers
      ? `${count(numbers, 'phone number')}: numbers bought through ${brand} are released at the carrier, the others stop reaching ${brand}`
      : count(0, 'phone number'),
  ]
}

/** The owner's list (Danger zone), from the server's preview. */
export function deleteOwnList(p: WorkspaceDeletePreviewData, brand: string): string[] {
  const { bought, attached } = p.numbers
  const numbers = !bought && !attached ? [count(0, 'phone number')] : []
  if (bought) numbers.push(`${count(bought, 'phone number')} bought through ${brand}: released at the carrier`)
  if (attached)
    numbers.push(
      `${count(attached, 'phone number')} you brought or connected: ${attached === 1 ? 'it stops' : 'they stop'} reaching ${brand} and ${attached === 1 ? 'stays' : 'stay'} yours`,
    )
  return workspaceDeleteList({
    calls: p.calls,
    contacts: p.contacts,
    numbers,
    otherMembers: p.otherMembers,
    accountsDeleted: p.accountsDeleted,
  })
}

/**
 * The checkbox that keeps the accounts that would go with the workspace (members in no other workspace, the owner's
 * own too): off by default, so they are deleted; kept accounts wait for an invitation. None when no account goes.
 */
export function keepAccountsOption(p: Pick<WorkspaceDeletePreviewData, 'accountsDeleted' | 'ownAccountDeleted'>) {
  if (p.accountsDeleted) return p.ownAccountDeleted ? 'Keep these accounts, yours included' : 'Keep their accounts'
  return p.ownAccountDeleted ? 'Keep my account' : undefined
}

/** The dialog's words; the keep box only when an account would go (keepAccountsOption). */
export function deleteOwnConfirmation(p: WorkspaceDeletePreviewData, brand: string): DangerConfirmation {
  return {
    text: `This deletes ${p.name} and all its data for good.`,
    list: deleteOwnList(p, brand),
    after: 'This cannot be undone.',
    action: 'Delete workspace',
    busyAction: 'Deleting…',
    typed: p.name,
    option: keepAccountsOption(p),
  }
}

/** The separate warning about the owner's own account (DangerZone.tsx): null when it stays anyway. */
export function ownAccountWarning(p: Pick<WorkspaceDeletePreviewData, 'ownAccountDeleted'>, keep: boolean) {
  if (!p.ownAccountDeleted) return null
  return keep
    ? {
        tone: 'neutral' as const,
        title: 'Your account stays.',
        text: 'You land on the page that waits for an invitation to another workspace.',
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
