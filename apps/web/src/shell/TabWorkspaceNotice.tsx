// A tab stays on the workspace it was opened on. When the session moves to another one (a switch in
// another tab) or the server refuses this tab's workspace, the tab stops reading and sending and shows
// this instead of the app: which workspace it is on, with Switch back and Reload. It never shows or
// writes another workspace's data on its own.
import type { WorkspaceRefusal } from '@linedesk/sync'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Me } from '../auth.ts'
import { useStore } from '../store.tsx'
import { onSwitchElsewhere } from '../tabWorkspace.ts'
import { Button, LogoMark } from '../ui/kit.tsx'
import { switchToWorkspace } from './invitations.ts'

type Named = { id: string; name: string }

export type TabNotice = { title: string; text: string; switchBack: string | null; reload: string }

/** What the notice says: the tab's workspace by name, and the one the session is on now when known. */
export function tabNotice(refusal: WorkspaceRefusal, tab: Named, workspaces: Named[]): TabNotice {
  if (refusal.code === 'account_switched') {
    return {
      title: 'Someone else signed in',
      text: 'Another account signed in on this browser in another tab. Changes made here were not sent as them.',
      switchBack: null,
      reload: 'Reload',
    }
  }
  if (refusal.code === 'client_outdated') {
    return {
      title: 'Linedesk was updated',
      text: 'Reload to continue with the new version. Changes made here are kept and sent after the reload.',
      switchBack: null,
      reload: 'Reload',
    }
  }
  if (refusal.code === 'workspace_access_lost') {
    return {
      title: `You no longer have access to ${tab.name}`,
      text: 'You were removed from this workspace, or it no longer exists.',
      switchBack: null,
      reload: 'Reload',
    }
  }
  const other = workspaces.find(w => w.id === refusal.activeWorkspaceId)?.name
  return {
    title: `This tab is on ${tab.name}`,
    text: `You switched to ${other ?? 'another workspace'} in another tab. This tab sends nothing until you choose; changes made here are kept.`,
    switchBack: `Switch back to ${tab.name}`,
    reload: other ? `Open ${other}` : 'Reload',
  }
}

/** Shows the app, or the notice once this tab's workspace is not the session's any more. */
export function TabWorkspaceGuard({ me, children }: { me: Me; children: ReactNode }) {
  const store = useStore()
  const refused = useSyncExternalStore(store.subscribe, () => store.getSnapshot().refused)
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
  return <TabWorkspaceNotice notice={tabNotice(refusal, tab, me.workspaces ?? [])} tabWorkspaceId={tab.id} />
}

function TabWorkspaceNotice({ notice, tabWorkspaceId }: { notice: TabNotice; tabWorkspaceId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const switchBack = () => {
    setBusy(true)
    setError(null)
    // Back on this tab's workspace; the reload keeps the page and sends what waited.
    switchToWorkspace(tabWorkspaceId, null).catch((e: unknown) => {
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
        {notice.switchBack && (
          <Button variant="primary" disabled={busy} onClick={switchBack} autoFocus>
            {busy ? 'Switching…' : notice.switchBack}
          </Button>
        )}
        <Button
          variant={notice.switchBack ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => window.location.reload()}
          autoFocus={!notice.switchBack}
        >
          {notice.reload}
        </Button>
      </div>
    </div>
  )
}
