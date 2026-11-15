// What Workspace settings › Danger zone says before an owner deletes the workspace (DangerZone.tsx), as plain
// functions of the server's preview (workspace.deletePreview), so the words are tested without a browser.
import type { WorkspaceDeletePreviewData } from '@linedesk/actions'
import type { DangerConfirmation } from '../ui/DangerConfirmDialog.tsx'
import { i18n } from '../i18n/index.tsx'

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
  const { t } = i18n()
  return [
    t('settings.danger.list.calls', { count: f.calls }),
    t('settings.danger.list.contacts', { count: f.contacts }),
    ...f.numbers,
    t('settings.danger.list.rest'),
    ...(f.otherMembers ? [t('settings.danger.list.members', { count: f.otherMembers })] : []),
    ...(f.accountsDeleted ? [t('settings.danger.list.accounts', { count: f.accountsDeleted })] : []),
  ]
}

/** The phone number lines when nothing is known but how many there are (a server admin's delete). */
export function numberLines(numbers: number, brand: string): string[] {
  const { t } = i18n()
  return [
    numbers
      ? t('settings.danger.numbers.admin', { count: numbers, brand })
      : t('settings.danger.numbers.count', { count: 0 }),
  ]
}

/** The owner's list (Danger zone), from the server's preview. */
export function deleteOwnList(p: WorkspaceDeletePreviewData, brand: string): string[] {
  const { t } = i18n()
  const { bought, attached } = p.numbers
  const numbers = !bought && !attached ? [t('settings.danger.numbers.count', { count: 0 })] : []
  if (bought) numbers.push(t('settings.danger.numbers.bought', { count: bought, brand }))
  if (attached) numbers.push(t('settings.danger.numbers.attached', { count: attached, brand }))
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
  const { t } = i18n()
  if (p.accountsDeleted)
    return p.ownAccountDeleted ? t('settings.danger.keep.theseAndMine') : t('settings.danger.keep.theirs')
  return p.ownAccountDeleted ? t('settings.danger.keep.mine') : undefined
}

/** The dialog's words; the keep box only when an account would go (keepAccountsOption). */
export function deleteOwnConfirmation(p: WorkspaceDeletePreviewData, brand: string): DangerConfirmation {
  const { t } = i18n()
  return {
    text: t('settings.danger.delete.text', { name: p.name }),
    list: deleteOwnList(p, brand),
    after: t('settings.danger.delete.after'),
    action: t('settings.danger.delete.action'),
    busyAction: t('settings.danger.delete.busy'),
    typed: p.name,
    option: keepAccountsOption(p),
  }
}

/** The separate warning about the owner's own account (DangerZone.tsx): null when it stays anyway. */
export function ownAccountWarning(p: Pick<WorkspaceDeletePreviewData, 'ownAccountDeleted'>, keep: boolean) {
  if (!p.ownAccountDeleted) return null
  const { t } = i18n()
  return keep
    ? {
        tone: 'neutral' as const,
        title: t('settings.danger.own.stays.title'),
        text: t('settings.danger.own.stays.text'),
      }
    : {
        tone: 'danger' as const,
        title: t('settings.danger.own.deleted.title'),
        text: t('settings.danger.own.deleted.text'),
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
