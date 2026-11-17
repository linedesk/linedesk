// The workspace button at the top of the navigation: the current workspace's icon (or initial) and name. It opens
// the one menu of the navigation (like Resend's): your workspaces to switch between and invitations
// (WorkspaceSwitcher), New workspace…, then you (name and email), Account settings, Keyboard shortcuts, this
// install's help and legal links and Sign out. Workspace settings are not in it: they are in the sidebar, once.
// The open menu is in the top layer (ui/floating.ts), so the navigation's scrolling never cuts it off.
// While the workspace is open its icon is also the browser tab's.
import type { MyInvitation } from '@linedesk/actions'
import { useEffect, useRef } from 'react'
import { auth, fetchAuthMethods, type LegalLinks } from '../auth.ts'
import { setWorkspaceFavicon } from '../brand.ts'
import { useQuery } from '../cachedQuery.ts'
import { memberAvatar, useMember } from '../team/members.ts'
import { useAnchoredList } from '../ui/floating.ts'
import type { IconName } from '../ui/icons.ts'
import { type ImageState, useImageReady } from '../ui/imageReady.ts'
import { Avatar, cx, Icon, Kbd } from '../ui/kit.tsx'
import { Skeleton, useLoading } from '../ui/LoadStates.tsx'
import { useMenu } from './useMenu.ts'
import { WorkspaceMark, workspaceIconOf } from './WorkspaceMark.tsx'
import { refreshWorkspaces, useWorkspaces, type Workspace, WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'
import { useT } from '@linedesk/i18n/react'
import { useMyPartners } from '../partner/partner-api.ts'

export type WorkspaceMenuItem = 'switcher' | 'new' | 'account' | 'shortcuts' | 'help' | 'terms' | 'privacy' | 'sign-out'

/**
 * What the workspace menu lists, in order. `canCreate`: POST /v1/workspaces would allow a new workspace;
 * `links`: this install's support email, terms and privacy (null while unknown, none that are not set).
 * The workspaces always lead (the current one checked); Account settings, Keyboard shortcuts and Sign out
 * are always there. Nothing about managing the workspace: that is Workspace settings in the sidebar.
 */
export function workspaceMenuItems({
  canCreate,
  links,
}: {
  canCreate: boolean
  links: LegalLinks | null
}): WorkspaceMenuItem[] {
  const items: WorkspaceMenuItem[] = ['switcher']
  if (canCreate) items.push('new')
  items.push('account', 'shortcuts')
  if (links?.supportEmail) items.push('help')
  if (links?.terms) items.push('terms')
  if (links?.privacy) items.push('privacy')
  items.push('sign-out')
  return items
}

/**
 * The workspaces the switcher lists: the member's list with the current workspace's name as the session has
 * it (just renamed), or the current one alone while the list is not known yet.
 */
export function switcherWorkspaces(all: Workspace[] | null, current: { id: string; name: string }): Workspace[] {
  if (!all?.length) return [{ id: current.id, name: current.name }]
  return all.map(w => (w.id === current.id ? { ...w, name: current.name } : w))
}

export { workspaceInitial } from './WorkspaceMark.tsx'

/**
 * The you-row waits while who is signed in is not known yet (the session) or their picture is still on its way;
 * a picture that failed shows the initials, so it doesn't wait for that.
 */
export const youRowLoading = (who: string, picture: ImageState) => !who || picture === 'loading'

/**
 * The you-row while it waits (docs/design-principles.md rule 15): a round picture and the lines of text that come,
 * as tall as the row itself. `lines`: 2 until the session is known, then whether there is a name above the email.
 */
export function YouRowSkeleton({ lines, reserved }: { lines: 1 | 2; reserved: boolean }) {
  return (
    <div className={cx('ws-me', 'ld-busy', reserved && 'is-reserved')} aria-hidden="true">
      <Skeleton shape="block" className="sk-round" width={24} height={24} />
      <div>
        <Skeleton shape="text" width={96} />
        {lines === 2 && <Skeleton shape="text" width={140} />}
      </div>
    </div>
  )
}

/** This install's terms, privacy and support links: the last known ones at once, none that are not set. */
export const loadAuthMethods = () => fetchAuthMethods({ attempts: 1 })
export function useLegalLinks(): LegalLinks | null {
  return useQuery('auth-methods', loadAuthMethods, { persist: true }).data?.links ?? null
}

type Props = {
  name: string
  id: string
  navOpen: boolean
  invitations: MyInvitation[]
  /** Loads the invitations again: when the menu opens, after a decline (nothing during support access). */
  onInvitationsChanged: () => void
  toast: (message: string) => void
  /** Set only where POST /v1/workspaces would allow this person to create a workspace. */
  onNewWorkspace?: () => void
  /** The signed-in member's profile picture as /v1/me had it; their synced member row wins (a picture just changed). */
  avatarUrl?: string | null
  onAccount: () => void
  onShortcuts: () => void
  onSignOut: () => void
}

function Item({ label, icon, keys, onClick }: { label: string; icon: IconName; keys?: string[]; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="nav-item" onClick={onClick}>
      <Icon name={icon} size={15} />
      <span className="lbl">{label}</span>
      {keys && <Kbd keys={keys} />}
    </button>
  )
}

function LinkItem({ label, icon, href }: { label: string; icon: IconName; href: string }) {
  const external = !href.startsWith('mailto:')
  return (
    <a
      role="menuitem"
      className="nav-item"
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
    >
      <Icon name={icon} size={15} />
      <span className="lbl">{label}</span>
    </a>
  )
}

export function WorkspaceMenu({
  name,
  id,
  navOpen,
  invitations,
  onInvitationsChanged,
  toast,
  onNewWorkspace,
  avatarUrl,
  onAccount,
  onShortcuts,
  onSignOut,
}: Props) {
  const t = useT()
  // In the background when it opens: the menu already shows the last known lists.
  const menu = useMenu(navOpen, () => {
    void refreshWorkspaces()
    onInvitationsChanged()
  })
  const list = useRef<HTMLDivElement>(null)
  useAnchoredList(menu.open, menu.trigger, list, { minWidth: 240 })
  const workspaces = useWorkspaces() // known with the session; here so the menu never waits for it
  // The white-label partners whose team this person is on: their partner area (docs/white-label.md).
  const partners = useMyPartners()
  const links = useLegalLinks()
  const user = auth.useSession().data?.user
  const userName = user?.name ?? ''
  const email = user?.email ?? ''
  const myRow = useMember(user?.id ?? null)
  const picture = myRow ? memberAvatar(myRow) : (avatarUrl ?? null)
  // Asked for as soon as the navigation is there, not when the menu opens: by then it is in the browser's cache.
  const pictureState = useImageReady(picture)
  const items = workspaceMenuItems({ canCreate: !!onNewWorkspace, links })
  const waiting = invitations.length
  const iconUrl = workspaceIconOf(workspaces, id)
  // The tab shows the workspace's icon while it is open; the install's again after (sign-out, no icon).
  useEffect(() => {
    setWorkspaceFavicon(iconUrl)
    return () => setWorkspaceFavicon(null)
  }, [iconUrl])
  const who = userName || email
  const youRow = useLoading(youRowLoading(who, pictureState))
  const youLines = who && !(userName && email) ? 1 : 2
  return (
    <div className="ws-wrap" ref={menu.root}>
      <button
        type="button"
        ref={menu.trigger}
        className="ws-btn"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.setOpen(!menu.open)}
        onKeyDown={menu.onTriggerKeyDown}
        title={
          waiting
            ? t('shell.workspaceMenu.invitationsTip', { workspace: name, count: waiting })
            : t('shell.workspaceMenu.tip', { workspace: name })
        }
      >
        <WorkspaceMark name={name} iconUrl={iconUrl}>
          {waiting > 0 && <span className="me-dot" />}
        </WorkspaceMark>
        <span className="ws-name">{name}</span>
        <Icon name="down" size={14} className="me-chevron" />
      </button>
      {menu.open && (
        <div
          ref={list}
          popover="manual"
          className="ws-menu k-float"
          role="menu"
          aria-label={t('shell.workspaceMenu.label', { workspace: name })}
          onKeyDown={menu.onKeyDown}
        >
          <WorkspaceSwitcher
            all={switcherWorkspaces(workspaces, { id, name })}
            currentId={id}
            invitations={invitations}
            onInvitationsChanged={onInvitationsChanged}
            onError={m => {
              menu.setOpen(false)
              toast(m)
            }}
          />
          {partners.map(p => (
            <Item
              key={p.id}
              label={t('shell.workspaceMenu.partner', { partner: p.name })}
              icon="users"
              onClick={menu.choose(() => (window.location.hash = '#partner'))}
            />
          ))}
          {partners.length > 0 && <hr />}
          {items.includes('new') && onNewWorkspace && (
            <>
              <Item label={t('shell.workspaceMenu.newWorkspace')} icon="plus" onClick={menu.choose(onNewWorkspace)} />
              <hr />
            </>
          )}
          <div
            className="ws-account"
            role="group"
            aria-label={
              who
                ? t('shell.workspaceMenu.signedInAs', { who: userName && email ? `${who}, ${email}` : who })
                : t('shell.workspaceMenu.yourAccount')
            }
          >
            {youRow.phase === 'reserve' || youRow.phase === 'skeleton' ? (
              <YouRowSkeleton lines={youLines} reserved={youRow.phase === 'reserve'} />
            ) : (
              who && (
                <div className={cx('ws-me', youRow.fadeIn && 'ld-in')} aria-hidden="true" title={email || undefined}>
                  <Avatar name={who} size={24} src={picture} />
                  <div>
                    <b>{who}</b>
                    {userName && email && <small>{email}</small>}
                  </div>
                </div>
              )
            )}
            <Item label={t('shell.page.account')} icon="user" onClick={menu.choose(onAccount)} />
            <Item label={t('shell.help.title')} icon="keyboard" keys={['?']} onClick={menu.choose(onShortcuts)} />
            {items.includes('help') && links?.supportEmail && (
              <LinkItem label={t('common.legal.help')} icon="mail" href={`mailto:${links.supportEmail}`} />
            )}
            {items.includes('terms') && links?.terms && (
              <LinkItem label={t('common.legal.terms')} icon="globe" href={links.terms} />
            )}
            {items.includes('privacy') && links?.privacy && (
              <LinkItem label={t('common.legal.privacy')} icon="globe" href={links.privacy} />
            )}
          </div>
          <hr />
          <Item label={t('shell.signOut')} icon="arrow-up-right" onClick={menu.choose(onSignOut)} />
        </div>
      )}
    </div>
  )
}
