// Admin mode: the operator's view above the workspaces, with its own sidebar instead of the
// inbox. Sections are routes (`#admin/<section>[/<id>]`). Esc steps back: from a detail to its
// list, from a list out of admin mode to where the user was.
import { PasskeyStepUpHost } from './PasskeyStepUp.tsx'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Toast } from '../shell/Toast.tsx'
import type { IconName } from '../ui/icons.ts'
import { Icon, Kbd } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import type { ListKeys } from './AdminList.tsx'
import { ADMIN_DATA, ADMIN_HEALTH, type AdminHealth, loadAdminData, loadHealth, watchAdminSignIn } from './api.ts'
import type { AdminSecondFactor } from '../auth.ts'
import { SecondFactorPrompt } from './SecondFactorPrompt.tsx'
import { AuditLog } from './AuditLog.tsx'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { errorText, type Notify } from './notify.ts'
import { Overview } from './Overview.tsx'
import { Providers } from './Providers.tsx'
import { type AdminSection, adminSections, useAdminPlace } from './route.ts'
import { System } from './System.tsx'
import { Usage } from './Usage.tsx'
import { UserDetail, UsersList } from './UsersPage.tsx'
import { WorkspaceDetail, WorkspacesList } from './WorkspacesPage.tsx'
import './admin.css'

const icons: Record<AdminSection, IconName> = {
  overview: 'waveform',
  workspaces: 'database',
  users: 'users',
  usage: 'clock',
  providers: 'plug',
  system: 'gear',
  audit: 'shield',
}

type ToastState = { text: string; undo?: () => Promise<unknown> }

/** While focus is in a field, keys are text. */
const isTyping = (el: Element | null) =>
  !!el &&
  (el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable ||
    (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test((el as HTMLInputElement).type)))

const swallow = (e: KeyboardEvent) => {
  e.preventDefault()
  e.stopImmediatePropagation()
}

function useAdminToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** The pending undo, taken out before it runs: a second Z or click finds nothing. */
  const pending = useRef<ToastState['undo']>(undefined)
  const notify: Notify = useCallback((text, undo) => {
    pending.current = undo
    setToast({ text, undo })
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => {
        pending.current = undefined
        setToast(null)
      },
      undo ? 6000 : 2600,
    )
  }, [])
  const undo = useCallback(async () => {
    const run = pending.current
    pending.current = undefined
    if (!run) return
    setToast(null)
    try {
      await run()
      notify('Undone.')
    } catch (err) {
      notify(errorText(err))
    }
  }, [notify])
  return { toast, notify, undo }
}

const partNames: Record<keyof AdminHealth, string> = {
  api: 'API',
  livekit: 'LiveKit',
  sip: 'Phone (SIP)',
  agent: 'Voice agent',
  email: 'Email',
}

/** The parts of the install that report a problem, checked when admin opens and every few minutes. */
function useHealthProblems(): string[] {
  // The same answer the overview's Health card shows; the overview says when it cannot be read.
  const health = useQuery(ADMIN_HEALTH, loadHealth).data
  useEffect(() => {
    const timer = setInterval(() => void refreshQuery(ADMIN_HEALTH), 5 * 60_000)
    return () => clearInterval(timer)
  }, [])
  if (!health) return []
  return (Object.keys(partNames) as (keyof AdminHealth)[]).filter(k => !health[k].ok).map(k => partNames[k])
}

type Props = { currentUserId: string; onExit: () => void }

export function AdminMode({ currentUserId, onExit }: Props) {
  const { place, go } = useAdminPlace()
  // Shown at once when admin is opened again in this page; loaded again in the background.
  const adminData = useQuery(ADMIN_DATA, loadAdminData)
  const data = adminData.data ?? null
  const error = data ? null : adminData.error
  const reload = adminData.reload
  const { toast, notify, undo } = useAdminToast()
  const listKeys = useRef<ListKeys | null>(null)
  const problems = useHealthProblems()
  // The session stopped opening Admin while it was open (1 hour without a passkey): sign in again here.
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])

  // Runs before the app's own key handler, which belongs to the inbox.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘K and ? would open the inbox's palette and help sheet, which admin mode does not show.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return swallow(e)
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) return
      // An open form (a confirmation, a key form, Invite user) handles its own keys: Esc cancels it.
      if (document.activeElement?.closest('form')) return
      // An open list (kit Select) handles its own keys.
      if (document.activeElement?.closest('[role="listbox"]')) return
      if (isTyping(document.activeElement)) {
        if (e.key === 'Escape') (document.activeElement as HTMLElement).blur()
        return
      }
      // Enter and Space on a focused button or link belong to that control.
      const tag = document.activeElement?.tagName
      if ((e.key === 'Enter' || e.key === ' ') && (tag === 'BUTTON' || tag === 'A')) return
      const section = adminSections[Number(e.key) - 1]
      let handled = true
      if (e.key === 'Escape') place.id ? go({ section: place.section, id: null }) : onExit()
      else if (section) go({ section: section.id, id: null })
      // Tab moves between sections, as it moves between views in the inbox; it never walks focus.
      else if (e.key === 'Tab') {
        const at = adminSections.findIndex(s => s.id === place.section)
        const next = adminSections[(at + (e.shiftKey ? adminSections.length - 1 : 1)) % adminSections.length]!
        ;(document.activeElement as HTMLElement | null)?.blur()
        go({ section: next.id, id: null })
      }
      // Z only ever undoes here: the inbox's undo would act on a call out of sight.
      else if (e.key === 'z') void undo()
      // M and ? would open the inbox's menu and help, / its search: here / searches the list.
      else if (e.key === 'm' || e.key === '?') handled = true
      else handled = (!place.id && (listKeys.current?.(e.key) ?? false)) || e.key === '/'
      if (handled) swallow(e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [place, go, onExit, undo])

  const meta = adminSections.find(s => s.id === place.section)!
  const open = (id: string) => go({ section: place.section, id })
  const shared = { notify, reload }
  const workspace =
    place.section === 'workspaces' && place.id ? data?.workspaces.find(w => w.id === place.id) : undefined
  const user = place.section === 'users' && place.id ? data?.users.find(u => u.id === place.id) : undefined
  const detailTitle = workspace?.name ?? (user ? user.name || user.email : null)

  function page(): ReactNode {
    // The overview loads its own numbers, so it shows while the lists are still on their way.
    if (place.section === 'overview') return <Overview onOpen={section => go({ section, id: null })} />
    if (!data)
      return error ? (
        <LoadProblem className="adm-card" what="Admin" message={error} onRetry={() => void reload()} />
      ) : (
        <div className="adm-card adm-listcard">
          <SkeletonRows label="Loading" />
        </div>
      )
    if (place.id && !detailTitle) return <p className="adm-notice">Not found.</p>
    switch (place.section) {
      case 'workspaces':
        return workspace ? (
          <WorkspaceDetail workspace={workspace} users={data.users} {...shared} />
        ) : (
          <WorkspacesList workspaces={data.workspaces} onOpen={open} keysRef={listKeys} {...shared} />
        )
      case 'users':
        return user ? (
          <UserDetail user={user} workspaces={data.workspaces} currentUserId={currentUserId} {...shared} />
        ) : (
          <UsersList users={data.users} currentUserId={currentUserId} onOpen={open} keysRef={listKeys} {...shared} />
        )
      case 'usage':
        return <Usage workspaces={data.workspaces} usage={data.usage} months={data.usageMonths} />
      case 'providers':
        return (
          <Providers
            providers={data.providers}
            active={data.activeProviders}
            canStore={data.canStoreKeys}
            {...shared}
          />
        )
      case 'system':
        return <System />
      case 'audit':
        return <AuditLog workspaces={data.workspaces} />
    }
  }

  // After signing in, the page loads again at the same admin address (SecondFactorPrompt).
  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onExit} />

  return (
    <div className="adm-mode">
      <PasskeyStepUpHost />
      <nav className="adm-side" aria-label="Admin">
        <button type="button" className="adm-back" onClick={onExit} title="Back to Linedesk (esc)">
          <Icon name="left" size={15} />
          <span>Back to Linedesk</span>
        </button>
        <p className="adm-side-label">Admin</p>
        {adminSections.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className="nav-item"
            aria-current={s.id === place.section ? 'page' : undefined}
            title={`${s.label} (${i + 1})`}
            onClick={() => go({ section: s.id, id: null })}
          >
            <Icon name={icons[s.id]} size={15} />
            <span className="lbl">{s.label}</span>
            {s.id === 'overview' && problems.length > 0 && (
              <span
                className="adm-nav-dot"
                role="img"
                aria-label={`Problem: ${problems.join(', ')}`}
                title={`Problem: ${problems.join(', ')}`}
              />
            )}
            <Kbd keys={[String(i + 1)]} />
          </button>
        ))}
      </nav>
      <main className="adm-main">
        <div
          className={place.section === 'providers' || place.section === 'audit' ? 'adm-col adm-col-wide' : 'adm-col'}
        >
          <header className="adm-head">
            {detailTitle ? (
              <>
                <button
                  type="button"
                  className="adm-crumb"
                  onClick={() => go({ section: place.section, id: null })}
                  title={`Back to ${meta.label} (esc)`}
                >
                  <Icon name="left" size={13} />
                  {meta.label}
                </button>
                <h1>{detailTitle}</h1>
              </>
            ) : (
              <>
                <h1>{meta.label}</h1>
                {meta.description && <p>{meta.description}</p>}
              </>
            )}
          </header>
          <div className="adm-body" key={`${place.section}/${place.id ?? ''}`}>
            {page()}
          </div>
        </div>
      </main>
      {toast && <Toast toast={{ text: toast.text, undo: !!toast.undo }} onUndo={() => void undo()} />}
    </div>
  )
}

/** For someone who opens an admin address without being an instance admin. */
export function AdminNotice() {
  return (
    <div className="page">
      <div className="page-in">
        <div className="empty">
          <b>Admin is for instance admins</b>
          <span>Ask your administrator for access.</span>
        </div>
      </div>
    </div>
  )
}
