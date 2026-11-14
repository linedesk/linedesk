import { formatStarCount, type MyInvitation, STAR_REPO, STAR_REPO_URL } from '@linedesk/actions'
import { useEffect, useRef, type ReactNode } from 'react'
import { auth } from '../auth.ts'
import { setReportedMember } from '../errorReporting.ts'
import { assigneeTabs, type InboxTab } from '../inbox-model.ts'
import type { IconName } from '../ui/icons.ts'
import { Button, cx, Icon, Kbd } from '../ui/kit.tsx'
import { useBrand } from '../brand.ts'
import { pages, type PageRoute, type Route } from './pages.tsx'
import { useFocusTrap } from '../ui/useFocusTrap.ts'
import { WorkspaceMenu } from './WorkspaceMenu.tsx'

type Props = {
  open: boolean
  /** Shown beside the content on wide windows: no focus trap, stays open after choosing, no close button. */
  docked?: boolean
  route: Route
  tab: InboxTab
  unreadCount: number
  reminderCount: number
  /** Open calls assigned to the signed-in member, and Needs you calls nobody has; null hides both (a workspace of one). */
  mineCount: number | null
  unassignedCount: number | null
  /** Owners and admins: open items in How <assistant> did (calls to look at, questions), on Assistant; null for members. */
  reviewCount: number | null
  workspaceName: string
  workspaceId: string
  /** A short notice at the bottom of the screen. */
  toast: (message: string) => void
  /** Invitations to other workspaces, shown in the workspace menu. */
  invitations: MyInvitation[]
  onInvitationsChanged: () => void
  onInbox: (tab: InboxTab) => void
  onPage: (route: PageRoute, section?: string) => void
  isInstanceAdmin: boolean
  /** Set only where POST /v1/workspaces would allow this person to create a workspace: the workspace menu offers it. */
  onNewWorkspace?: () => void
  onHelp: () => void
  onSignOut: () => void
  onClose: () => void
}

function NavItem({ label, icon, keys, current, sub, muted, badge, title, onClick }: { label: string; icon: IconName; keys?: string[]; current?: boolean; sub?: boolean; muted?: boolean; badge?: ReactNode; title?: string; onClick: () => void }) {
  return (
    <button type="button" className={cx('nav-item', sub && 'nav-sub', muted && 'is-admin')} aria-current={current ? 'page' : undefined} title={title} onClick={onClick}>
      <Icon name={icon} size={15} /><span className="lbl">{label}</span>{badge}{keys && <Kbd keys={keys} />}
    </button>
  )
}

/** Slide-in navigation: opens from ☰ or M; closes with Esc, the close button, a click outside or after choosing.
 * On very wide windows it is docked: always open beside the content. Two parts: the workspace button on top (one
 * menu: switch workspace, your account, sign out) and one list of pages, Workspace settings once at its end. */
export function Nav({ open, docked = false, route, tab, unreadCount, reminderCount, mineCount, unassignedCount, reviewCount, workspaceName, workspaceId, toast, invitations, onInvitationsChanged, isInstanceAdmin, onNewWorkspace, onClose, ...on }: Props) {
  const ref = useRef<HTMLElement>(null)
  useFocusTrap(ref, open && !docked, { initial: '.nav-item[aria-current="page"]' }) // opens on the current page, gives focus back when it closes
  const sessionUser = auth.useSession().data?.user
  const userName = sessionUser?.name ?? ''
  const memberId = sessionUser?.id
  const memberEmail = sessionUser?.email
  // Errors are reported for whoever is signed in now, also after switching accounts without a reload.
  useEffect(() => {
    setReportedMember(memberId ? { id: memberId, email: memberEmail, name: userName } : null)
  }, [memberId, memberEmail, userName])
  const go = (run: () => void) => () => { if (!docked) onClose(); run() }
  const onCalls = route === 'calls'
  return (
    <nav className="nav" aria-label="Main" ref={ref} inert={!open}>
      <div className="ws-top">
        <WorkspaceMenu name={workspaceName} id={workspaceId} navOpen={open} invitations={invitations} onInvitationsChanged={onInvitationsChanged} toast={toast}
          onNewWorkspace={onNewWorkspace && go(onNewWorkspace)} onAccount={go(() => on.onPage('account'))} onShortcuts={go(on.onHelp)} onSignOut={go(on.onSignOut)} />
        {!docked && <Button size="sm" variant="ghost" icon="left" aria-label="Close menu" title="Close (esc)" onClick={onClose} />}
      </div>
      <NavItem label="Inbox" icon="phone" keys={['G', 'I']} current={onCalls && tab !== 'reminders' && tab !== 'done' && !assigneeTabs.includes(tab)} onClick={go(() => on.onInbox('you'))}
        badge={unreadCount ? <span className="k-count">{unreadCount}</span> : null} />
      <NavItem sub label="Reminders" icon="clock" keys={['G', 'H']} current={onCalls && tab === 'reminders'} onClick={go(() => on.onInbox('reminders'))}
        badge={reminderCount ? <span className="nav-n">{reminderCount}</span> : null} />
      {mineCount !== null && (
        <NavItem sub label="Assigned to me" icon="user" keys={['G', 'M']} current={onCalls && tab === 'mine'} onClick={go(() => on.onInbox('mine'))}
          badge={mineCount ? <span className="nav-n">{mineCount}</span> : null} />
      )}
      {unassignedCount !== null && (
        <NavItem sub label="Unassigned" icon="users" keys={['G', 'U']} current={onCalls && tab === 'unassigned'} onClick={go(() => on.onInbox('unassigned'))}
          badge={unassignedCount ? <span className="nav-n">{unassignedCount}</span> : null} />
      )}
      <NavItem sub label="Done" icon="check" keys={['G', 'E']} current={onCalls && tab === 'done'} onClick={go(() => on.onInbox('done'))} />
      <NavItem label={pages.assistant.title} icon="waveform" keys={['G', 'A']} current={route === 'assistant'} onClick={go(() => on.onPage('assistant'))}
        badge={reviewCount ? <span className="nav-n" title="To look at in How the assistant did">{reviewCount}</span> : null} />
      <NavItem label={pages.contacts.title} icon="contact" keys={['G', 'C']} current={route === 'contacts'} onClick={go(() => on.onPage('contacts'))} />
      <NavItem label={pages.insights.title} icon="chart" keys={['G', 'N']} current={route === 'insights'} onClick={go(() => on.onPage('insights'))} />
      <hr className="nav-sep" />
      <NavItem label={pages.workspace.title} icon="gear" keys={['G', 'S']} current={route === 'workspace'} onClick={go(() => on.onPage('workspace'))} />
      {isInstanceAdmin && <NavItem muted label={pages.admin.title} icon="shield" keys={['G', 'D']}
        title="Server admin: providers, users and settings for every workspace on this server" onClick={go(() => on.onPage('admin'))} />}
      <div className="nav-foot">
        <StarLink />
      </div>
    </nav>
  )
}

/** Star on GitHub with the count the server last read (none while unknown); gone when an admin turned the star prompt off. */
function StarLink() {
  const { starPrompt, starCount } = useBrand()
  if (!starPrompt) return null
  const title = starCount === null ? `Open ${STAR_REPO} on GitHub` : `${starCount.toLocaleString('en-US')} ${starCount === 1 ? 'star' : 'stars'} on GitHub`
  return (
    <a className="nav-item" href={STAR_REPO_URL} target="_blank" rel="noreferrer" title={title}>
      <Icon name="star" size={15} /><span className="lbl">Star on GitHub</span>
      {starCount !== null && <span className="nav-stars">{formatStarCount(starCount)}</span>}
    </a>
  )
}

/** `badge`: something waits in the menu (an invitation). */
export function MenuButton({ open, onOpen, badge = false }: { open: boolean; onOpen: () => void; badge?: boolean }) {
  const button = <Button size="sm" variant="ghost" icon="menu" className="menu-btn" aria-label={badge ? 'Open menu, an invitation is waiting' : 'Open menu'} aria-expanded={open} title="Menu (M)" onClick={onOpen} />
  return badge ? <span className="me-avatar menu-btn-wrap">{button}<span className="me-dot" aria-hidden="true" /></span> : button
}
