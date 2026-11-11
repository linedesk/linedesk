// A tab stays on the workspace it was opened on. When the session moves to another one (a switch in
// another tab), the member loses access to it, or the session ends (signed out, expired, the account
// disabled), the tab stops reading and sending and shows this instead of the app: a calm screen that
// says what happened and what to do. It never shows or writes another workspace's data on its own.
import type { WorkspaceRefusal } from '@linedesk/sync'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Me } from '../auth.ts'
import { signOutAndForget } from '../localData.ts'
import { useStore } from '../store.tsx'
import { onSwitchElsewhere } from '../tabWorkspace.ts'
import { Button, LogoMark } from '../ui/kit.tsx'
import { switchToWorkspace } from './invitations.ts'

type Named = { id: string; name: string }

/** What a button does: `switch` makes `workspaceId` the session's and reloads into it. */
export type NoticeAction = { label: string } & (
  | { kind: 'switch'; workspaceId: string; keepPage: boolean }
  | { kind: 'reload' }
  | { kind: 'signOut' }
)
export type TabNotice = { title: string; text: string; actions: NoticeAction[] }

/** "1 change … was not saved." for writes rolled back because they could not be sent any more. */
export const notSavedText = (discarded: number) =>
  discarded === 0
    ? ''
    : ` ${discarded === 1 ? 'Your last change was' : `Your last ${discarded} changes were`} not saved.`

/** What the notice says and offers, by why the tab stopped. */
export function tabNotice(refusal: WorkspaceRefusal, tab: Named, workspaces: Named[], discarded = 0): TabNotice {
  if (refusal.code === 'signed_out') {
    return {
      title: 'You were signed out',
      text: `Sign in again to keep working.${notSavedText(discarded)}`,
      actions: [{ label: 'Sign in', kind: 'reload' }],
    }
  }
  if (refusal.code === 'account_switched') {
    return {
      title: 'Someone else signed in',
      text: 'Another account signed in on this browser in another tab. Changes made here were not sent as them.',
      actions: [{ label: 'Reload', kind: 'reload' }],
    }
  }
  if (refusal.code === 'client_outdated') {
    return {
      title: 'Linedesk was updated',
      text: 'Reload to continue with the new version. Changes made here are kept and sent after the reload.',
      actions: [{ label: 'Reload', kind: 'reload' }],
    }
  }
  if (refusal.code === 'workspace_access_lost') {
    const other = workspaces.find(w => w.id !== tab.id)
    return {
      title: `You no longer have access to ${tab.name}`,
      text: `You were removed from this workspace, or it no longer exists.${notSavedText(discarded)}`,
      actions: [
        other
          ? { label: `Switch to ${other.name}`, kind: 'switch', workspaceId: other.id, keepPage: false }
          : { label: 'Continue', kind: 'reload' },
        { label: 'Sign out', kind: 'signOut' },
      ],
    }
  }
  const other = workspaces.find(w => w.id === refusal.activeWorkspaceId)?.name
  return {
    title: `This tab is on ${tab.name}`,
    text: `You switched to ${other ?? 'another workspace'} in another tab. This tab sends nothing until you choose; changes made here are kept.`,
    actions: [
      { label: `Switch back to ${tab.name}`, kind: 'switch', workspaceId: tab.id, keepPage: true },
      { label: other ? `Open ${other}` : 'Reload', kind: 'reload' },
    ],
  }
}

/** Shows the app, or the notice once this tab's workspace is not the session's any more. */
export function TabWorkspaceGuard({ me, children }: { me: Me; children: ReactNode }) {
  const store = useStore()
  const refused = useSyncExternalStore(store.subscribe, () => store.getSnapshot().refused)
  const discarded = useSyncExternalStore(store.subscribe, () => store.getSnapshot().discarded)
  const tab = me.workspace!
  // Heard from the tab that switched: shown at once, before this tab's next request is refused.
  const [switchedTo, setSwitchedTo] = useState<string | null>(null)
  useEffect(
    () =>
      onSwitchElsewhere(id => {
        if (id !== tab.id) return setSwitchedTo(id)
        // Switched back to this tab's workspace elsewhere. A store that was refused meanwhile has
        // stopped for good: reload, so this tab reads and sends again (its queued changes too).
        if (store.getSnapshot().refused) return window.location.reload()
        setSwitchedTo(null)
      }),
    [tab.id, store],
  )
  const refusal: WorkspaceRefusal | null =
    refused ?? (switchedTo ? { code: 'workspace_switched', activeWorkspaceId: switchedTo } : null)
  if (!refusal) return children
  return <TabWorkspaceNotice notice={tabNotice(refusal, tab, me.workspaces ?? [], discarded)} />
}

async function perform(action: NoticeAction) {
  if (action.kind === 'switch') return switchToWorkspace(action.workspaceId, action.keepPage ? null : '#calls')
  if (action.kind === 'signOut') await signOutAndForget()
  window.location.reload()
}

function TabWorkspaceNotice({ notice }: { notice: TabNotice }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (action: NoticeAction) => () => {
    setBusy(true)
    setError(null)
    perform(action).catch((e: unknown) => {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    })
  }
  return (
    <div className="boot" role="alertdialog" aria-labelledby="tab-ws-title" aria-describedby="tab-ws-text">
      <span className="ws-mark boot-mark" aria-hidden="true">
        <LogoMark />
      </span>
      <b id="tab-ws-title">{notice.title}</b>
      <span id="tab-ws-text">{notice.text}</span>
      {error && <span role="alert">{error}</span>}
      <div className="boot-actions">
        {notice.actions.map((action, i) => (
          <Button
            key={action.label}
            variant={i === 0 ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={run(action)}
            autoFocus={i === 0}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
