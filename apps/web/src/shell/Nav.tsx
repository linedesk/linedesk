import { useRef, type ReactNode } from 'react'
import { auth } from '../auth.ts'
import type { InboxTab } from '../inbox-model.ts'
import type { IconName } from '../ui/icons.ts'
import { Button, Icon, Kbd } from '../ui/kit.tsx'
import { pages, type PageRoute, type Route } from './pages.tsx'
import { useFocusTrap } from '../ui/useFocusTrap.ts'
import { ProfileMenu } from './ProfileMenu.tsx'

type Props = {
  open: boolean
  route: Route
  tab: InboxTab
  unreadCount: number
  reminderCount: number
  workspaceName: string
  onInbox: (tab: InboxTab) => void
  onPage: (route: PageRoute) => void
  isInstanceAdmin: boolean
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

/** Slide-in navigation: opens from ☰ or M; closes with Esc, the close button, a click outside or after choosing. */
export function Nav({ open, route, tab, unreadCount, reminderCount, workspaceName, isInstanceAdmin, onClose, ...on }: Props) {
  const ref = useRef<HTMLElement>(null)
  useFocusTrap(ref, open) // focus moves in when it opens and back when it closes
  const userName = auth.useSession().data?.user.name ?? ''
  const go = (run: () => void) => () => { onClose(); run() }
  const onCalls = route === 'calls'
  return (
    <nav className="nav" aria-label="Main" ref={ref} inert={!open}>
      <div className="ws">
        <span className="ws-mark"><Icon name="spark" size={13} /></span><b>Linedesk</b>
        <Button size="sm" variant="ghost" icon="left" aria-label="Close menu" title="Close (esc)" onClick={onClose} />
      </div>
      <NavItem label="Inbox" icon="phone" keys={['G', 'I']} current={onCalls && tab !== 'reminders' && tab !== 'done'} onClick={go(() => on.onInbox('you'))}
        badge={unreadCount ? <span className="k-count">{unreadCount}</span> : null} />
      <NavItem sub label="Reminders" icon="clock" keys={['G', 'H']} current={onCalls && tab === 'reminders'} onClick={go(() => on.onInbox('reminders'))}
        badge={reminderCount ? <span className="nav-n">{reminderCount}</span> : null} />
      <NavItem sub label="Done" icon="check" keys={['G', 'E']} current={onCalls && tab === 'done'} onClick={go(() => on.onInbox('done'))} />
      <NavItem label={pages.assistant.title} icon="waveform" keys={['G', 'A']} current={route === 'assistant'} onClick={go(() => on.onPage('assistant'))} />
      {isInstanceAdmin && <NavItem label={pages.admin.title} icon="gear" current={route === 'admin'} onClick={go(() => on.onPage('admin'))} />}
      <div className="nav-foot">
        <NavItem label="Keyboard shortcuts" icon="keyboard" keys={['?']} onClick={go(on.onHelp)} />
        <ProfileMenu navOpen={open} name={userName} workspaceName={workspaceName} onAccount={go(() => on.onPage('account'))} onSignOut={go(on.onSignOut)} />
      </div>
    </nav>
  )
}

export function MenuButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return <Button size="sm" variant="ghost" icon="menu" className="menu-btn" aria-label="Open menu" aria-expanded={open} title="Menu (M)" onClick={onOpen} />
}
