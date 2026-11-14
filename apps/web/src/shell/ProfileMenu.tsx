import { auth, fetchAuthMethods, type LegalLinks } from '../auth.ts'
import { useQuery } from '../cachedQuery.ts'
import { Avatar, Icon } from '../ui/kit.tsx'
import type { IconName } from '../ui/icons.ts'
import { useMenu } from './useMenu.ts'

/** Only what is yours: your account, help and legal links, signing out. The workspace has its own menu at the top. */
type Props = { navOpen: boolean; onAccount: () => void; onSignOut: () => void }

/** This install's terms, privacy and support links: the last known ones at once, none that are not set. */
export const loadAuthMethods = () => fetchAuthMethods({ attempts: 1 })
function useLegalLinks(): LegalLinks | null {
  return useQuery('auth-methods', loadAuthMethods, { persist: true }).data?.links ?? null
}

function LinkItem({ label, icon, href }: { label: string; icon: IconName; href: string }) {
  const external = !href.startsWith('mailto:')
  return <a role="menuitem" className="nav-item" href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}><Icon name={icon} size={15} /><span className="lbl">{label}</span></a>
}

function Item({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return <button type="button" role="menuitem" className="nav-item" onClick={onClick}><Icon name={icon} size={15} /><span className="lbl">{label}</span></button>
}

/** The profile row at the bottom of the navigation: your name and email. Clicking it opens a small menu above it. */
export function ProfileMenu({ navOpen, onAccount, onSignOut }: Props) {
  const user = auth.useSession().data?.user
  const name = user?.name ?? ''
  const email = user?.email ?? ''
  const menu = useMenu(navOpen)
  const links = useLegalLinks()
  const hasLinks = !!(links?.terms || links?.privacy || links?.supportEmail)

  return (
    <div className="me-wrap" ref={menu.root}>
      {menu.open && (
        <div className="me-menu" role="menu" aria-label="Account" onKeyDown={menu.onKeyDown}>
          <Item label="Account settings" icon="user" onClick={menu.choose(onAccount)} />
          {hasLinks && <hr />}
          {links?.supportEmail && <LinkItem label="Help" icon="mail" href={`mailto:${links.supportEmail}`} />}
          {links?.terms && <LinkItem label="Terms" icon="globe" href={links.terms} />}
          {links?.privacy && <LinkItem label="Privacy" icon="globe" href={links.privacy} />}
          <hr />
          <Item label="Sign out" icon="arrow-up-right" onClick={menu.choose(onSignOut)} />
        </div>
      )}
      <button type="button" ref={menu.trigger} className="me" aria-haspopup="menu" aria-expanded={menu.open} onClick={() => menu.setOpen(!menu.open)} title={email || undefined}>
        <span className="me-avatar">
          <Avatar name={name || email} size={24} />
        </span>
        <div><b>{name || email}</b>{name && email && <small>{email}</small>}</div>
        <Icon name="down" size={14} className="me-chevron" />
      </button>
    </div>
  )
}
