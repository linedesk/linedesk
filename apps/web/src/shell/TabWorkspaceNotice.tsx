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
import { BrandMark, Button } from '../ui/kit.tsx'
import { switchToWorkspace } from './invitations.ts'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'

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
    : ` ${i18n().t('shell.tabNotice.notSaved', { count: discarded })}`

/** What the notice says and offers, by why the tab stopped. */
export function tabNotice(refusal: WorkspaceRefusal, tab: Named, workspaces: Named[], discarded = 0): TabNotice {
  const { t } = i18n()
  if (refusal.code === 'signed_out') {
    return {
      title: t('shell.tabNotice.signedOut.title'),
      text: `${t('shell.tabNotice.signedOut.text')}${notSavedText(discarded)}`,
      actions: [{ label: t('shell.tabNotice.signIn'), kind: 'reload' }],
    }
  }
  if (refusal.code === 'account_switched') {
    return {
      title: t('shell.tabNotice.switched.title'),
      text: t('shell.tabNotice.switched.text'),
      actions: [{ label: t('shell.tabNotice.reload'), kind: 'reload' }],
    }
  }
  if (refusal.code === 'client_outdated') {
    return {
      title: t('shell.tabNotice.outdated.title', { brand: brandName() }),
      text: t('shell.tabNotice.outdated.text'),
      actions: [{ label: t('shell.tabNotice.reload'), kind: 'reload' }],
    }
  }
  if (refusal.code === 'workspace_access_lost') {
    const other = workspaces.find(w => w.id !== tab.id)
    return {
      title: t('shell.tabNotice.lost.title', { workspace: tab.name }),
      text: `${t('shell.tabNotice.lost.text')}${notSavedText(discarded)}`,
      actions: [
        other
          ? { label: t('shell.tabNotice.switchTo', { workspace: other.name }), kind: 'switch', workspaceId: other.id, keepPage: false }
          : { label: t('shell.tabNotice.continue'), kind: 'reload' },
        { label: t('shell.signOut'), kind: 'signOut' },
      ],
    }
  }
  const other = workspaces.find(w => w.id === refusal.activeWorkspaceId)?.name
  return {
    title: t('shell.tabNotice.elsewhere.title', { workspace: tab.name }),
    text: other
      ? t('shell.tabNotice.elsewhere.text', { workspace: other })
      : t('shell.tabNotice.elsewhere.textUnknown'),
    actions: [
      { label: t('shell.tabNotice.switchBack', { workspace: tab.name }), kind: 'switch', workspaceId: tab.id, keepPage: true },
      { label: other ? t('shell.tabNotice.open', { workspace: other }) : t('shell.tabNotice.reload'), kind: 'reload' },
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
      <BrandMark className="ws-mark boot-mark" />
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
