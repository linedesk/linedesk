// The account menu in the setup pages' top bar (2026-11-18): the onboarding's steps (Frame.tsx), the AI agent setup page
// (AgentSetup.tsx) and the install by hand (InstallSetup.tsx) have no navigation, so no workspace menu. This one is the
// same menu, kept to what someone in the middle of setting up needs: the workspaces to switch to and the partner area
// (only when there is somewhere else to go), who is signed in, and Sign out. Its button is the person's initials or
// picture, small enough for a phone's top bar next to the step count.
//
// Signing out sends what is still unsent first (useSignOut); the setup's progress is on the server and is where it was
// after signing in again.
import { useT } from '@linedesk/i18n/react'
import { useRef, useState } from 'react'
import { auth } from '../auth.ts'
import { useMyPartners } from '../partner/partner-api.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import { useAnchoredList } from '../ui/floating.ts'
import { Avatar } from '../ui/kit.tsx'
import { useMenu } from './useMenu.ts'
import { useSignOut } from './useSignOut.ts'
import { Item, switcherWorkspaces } from './WorkspaceMenu.tsx'
import { refreshWorkspaces, useWorkspaces, WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

/**
 * Whether the menu lists the workspaces: only when there is another place to go, another workspace or a partner area
 * (the partner rows show then too).
 */
export const setupMenuSwitches = (workspaces: number, partners: number) => workspaces > 1 || partners > 0

export function SetupAccountMenu({ workspaceId }: { workspaceId?: string | null }) {
  const t = useT()
  const menu = useMenu(true, () => void refreshWorkspaces())
  const list = useRef<HTMLDivElement>(null)
  useAnchoredList(menu.open, menu.trigger, list, { minWidth: 240 })
  const workspaces = useWorkspaces()
  const partners = useMyPartners()
  const user = auth.useSession().data?.user
  const userName = user?.name ?? ''
  const email = user?.email ?? ''
  const who = userName || email
  // A change that could not be sent yet (offline): said in the menu, signing out again leaves it.
  const [notice, setNotice] = useState<string | null>(null)
  const signOut = useSignOut({ onSignedOut: () => window.location.assign('/'), toast: setNotice })
  const currentId = workspaceId ?? tabWorkspace() ?? ''
  const current = workspaces?.find(w => w.id === currentId)
  const switches = setupMenuSwitches(workspaces?.length ?? 0, partners.length)
  const label = t('shell.workspaceMenu.yourAccount')
  return (
    <div className="ws-wrap ob-me" ref={menu.root}>
      <button
        type="button"
        ref={menu.trigger}
        className="ob-me-btn"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={label}
        title={who ? t('shell.workspaceMenu.signedInAs', { who }) : label}
        onClick={() => {
          setNotice(null)
          menu.setOpen(!menu.open)
        }}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <Avatar name={who || '?'} size={24} src={user?.image ?? null} />
      </button>
      {menu.open && (
        <div
          ref={list}
          popover="manual"
          className="ws-menu k-float"
          role="menu"
          aria-label={label}
          onKeyDown={menu.onKeyDown}
        >
          {switches && (
            <>
              {workspaces && workspaces.length > 1 && (
                <WorkspaceSwitcher
                  all={current ? switcherWorkspaces(workspaces, current) : workspaces}
                  currentId={currentId}
                  invitations={[]}
                  onInvitationsChanged={() => {}}
                  onError={setNotice}
                />
              )}
              {partners.map(p => (
                <Item
                  key={p.id}
                  label={t('shell.workspaceMenu.partner', { partner: p.name })}
                  icon="users"
                  onClick={menu.choose(() => (window.location.hash = '#partner'))}
                />
              ))}
              {/* The workspace list ends in its own line; the partner rows get one, as in the workspace menu. */}
              {partners.length > 0 && <hr />}
            </>
          )}
          {who && (
            <div className="ws-me" aria-hidden="true" title={email || undefined}>
              <Avatar name={who} size={24} src={user?.image ?? null} />
              <div>
                <b>{who}</b>
                {userName && email && <small>{email}</small>}
              </div>
            </div>
          )}
          {notice && (
            <p className="ob-me-notice" role="status">
              {notice}
            </p>
          )}
          <Item label={t('shell.signOut')} icon="arrow-up-right" onClick={() => void signOut()} />
        </div>
      )}
    </div>
  )
}
