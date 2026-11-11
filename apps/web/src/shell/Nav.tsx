import type { MyInvitation } from '@linedesk/actions'
import { useRef, type ReactNode } from 'react'
import { auth } from '../auth.ts'
import { assigneeTabs, type InboxTab } from '../inbox-model.ts'
import type { IconName } from '../ui/icons.ts'
import { Button, Icon, Kbd, LogoMark } from '../ui/kit.tsx'
import { pages, type PageRoute, type Route } from './pages.tsx'
import { useFocusTrap } from '../ui/useFocusTrap.ts'
import { ProfileMenu } from './ProfileMenu.tsx'

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
  /** Owners and admins: calls whose evaluation needs a person; null hides Needs review. */
  reviewCount: number | null
  workspaceName: string
  workspaceId: string
  /** A short notice at the bottom of the screen. */
  toast: (message: string) => void
  /** Invitations to other workspaces, shown in the profile menu. */
  invitations: MyInvitation[]
  onInvitationsChanged: () => void
  onInbox: (tab: InboxTab) => void
  onPage: (route: PageRoute) => void
  isInstanceAdmin: boolean
  /** Set only where POST /v1/workspaces would allow this person to create a workspace: the profile menu offers it. */
  onNewWorkspace?: () => void
  onHelp: () => void
  onSignOut: () => void
  onClose: () => void
}

function NavItem({ label, icon, keys, current, sub, badge, onClick }: { label: string; icon: IconName; keys?: string[]; current?: boolean; sub?: boolean; badge?: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={sub ? 'nav-item nav-sub' : 'nav-item'} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} size={15} /><span className="lbl">{label}</span>{badge}{keys && <Kbd keys={keys} />}
    </button>
  )
}

/** Slide-in navigation: opens from ☰ or M; closes with Esc, the close button, a click outside or after choosing.
 * On very wide windows it is docked: always open beside the content. */
export function Nav({ open, docked = false, route, tab, unreadCount, reminderCount, mineCount, unassignedCount, reviewCount, workspaceName, workspaceId, toast, invitations, onInvitationsChanged, isInstanceAdmin, onNewWorkspace, onClose, ...on }: Props) {
  const ref = useRef<HTMLElement>(null)
  useFocusTrap(ref, open && !docked, { initial: '.nav-item[aria-current="page"]' }) // opens on the current page, gives focus back when it closes
  const userName = auth.useSession().data?.user.name ?? ''
  const go = (run: () => void) => () => { if (!docked) onClose(); run() }
  const onCalls = route === 'calls'
  return (
    <nav className="nav" aria-label="Main" ref={ref} inert={!open}>
      <div className="ws">
        <span className="ws-mark"><LogoMark /></span><b>Linedesk</b>
        {!docked && <Button size="sm" variant="ghost" icon="left" aria-label="Close menu" title="Close (esc)" onClick={onClose} />}
      </div>
      <NavItem label="Inbox" icon="phone" keys={['G', 'I']} current={onCalls && tab !== 'reminders' && tab !== 'done' && tab !== 'review' && !assigneeTabs.includes(tab)} onClick={go(() => on.onInbox('you'))}
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
      {reviewCount !== null && (
        <NavItem sub label="Needs review" icon="flag" keys={['G', 'R']} current={onCalls && tab === 'review'} onClick={go(() => on.onInbox('review'))}
          badge={reviewCount ? <span className="nav-n">{reviewCount}</span> : null} />
      )}
      <NavItem sub label="Done" icon="check" keys={['G', 'E']} current={onCalls && tab === 'done'} onClick={go(() => on.onInbox('done'))} />
      <NavItem label={pages.contacts.title} icon="contact" keys={['G', 'C']} current={route === 'contacts'} onClick={go(() => on.onPage('contacts'))} />
      <NavItem label={pages.insights.title} icon="chart" keys={['G', 'N']} current={route === 'insights'} onClick={go(() => on.onPage('insights'))} />
      <NavItem label={pages.assistant.title} icon="waveform" keys={['G', 'A']} current={route === 'assistant'} onClick={go(() => on.onPage('assistant'))} />
      <NavItem label={pages.settings.title} icon="gear" keys={['G', 'S']} current={route === 'settings'} onClick={go(() => on.onPage('settings'))} />
      <div className="nav-foot">
        <NavItem label="Keyboard shortcuts" icon="keyboard" keys={['?']} onClick={go(on.onHelp)} />
        <ProfileMenu navOpen={open} name={userName} workspaceName={workspaceName} workspaceId={workspaceId} toast={toast} invitations={invitations} onInvitationsChanged={onInvitationsChanged} onNewWorkspace={onNewWorkspace && go(onNewWorkspace)} onAdmin={isInstanceAdmin ? go(() => on.onPage('admin')) : undefined} onAccount={go(() => on.onPage('account'))} onTeam={go(() => on.onPage('team'))} onSignOut={go(on.onSignOut)} />
      </div>
    </nav>
  )
}

/** `badge`: something waits in the menu (an invitation). */
export function MenuButton({ open, onOpen, badge = false }: { open: boolean; onOpen: () => void; badge?: boolean }) {
  const button = <Button size="sm" variant="ghost" icon="menu" className="menu-btn" aria-label={badge ? 'Open menu, an invitation is waiting' : 'Open menu'} aria-expanded={open} title="Menu (M)" onClick={onOpen} />
  return badge ? <span className="me-avatar menu-btn-wrap">{button}<span className="me-dot" aria-hidden="true" /></span> : button
}
