// Admin mode: the operator's view above the workspaces, in the frame of Workspace and Account settings
// (SettingsLayout: title bar, sections at the left, one column), with a back button where the inbox's menu button is.
// Sections are routes (`#admin/<section>[/<id>]`). Esc steps back: from a detail to its list, from a list out of
// admin mode to where the user was.
import { PasskeyStepUpHost } from './PasskeyStepUp.tsx'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Toast } from '../shell/Toast.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { SettingsLayout } from '../ui/SettingsLayout.tsx'
import { useFormat, useT } from '@linedesk/i18n/react'
import { type MessageKey, msg } from '@linedesk/i18n'
import { i18n } from '../i18n/index.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import type { ListKeys } from './AdminList.tsx'
import { ADMIN_HEALTH, type HealthPart, loadHealth, watchAdminSignIn } from './api.ts'
import type { AdminSecondFactor } from '../auth.ts'
import { SecondFactorPrompt } from './SecondFactorPrompt.tsx'
import { SecondPasskeyNote } from './SecondPasskeyNote.tsx'
import { AuditLog } from './AuditLog.tsx'
import { CallReviews } from './CallReviews.tsx'
import { Billing, billingPartTitle, useBillTitle } from './Billing.tsx'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { errorText, type Notify } from './notify.ts'
import { Onboarding } from './Onboarding.tsx'
import { Overview } from './Overview.tsx'
import { Partners } from './Partners.tsx'
import { Providers } from './Providers.tsx'
import { useProviderStatus } from './providerStatus.ts'
import { useAdminData } from './useAdminData.ts'
import { StatusCard } from './StatusCard.tsx'
import {
  adminSections,
  isListPlace,
  nextSection,
  placeUp,
  sectionIndexOfKey,
  sectionKey,
  adminGroups,
  tabSwitchesSection,
  useAdminPlace,
} from './route.ts'
import { Server } from './Server.tsx'
import { CallSettings, SignupSettings, ToolSettings } from './Settings.tsx'
import { GermanNumbers, ImpersonationEmails } from './SettingsCards.tsx'
import { SystemPrompt } from './SystemPrompt.tsx'
import { BrandingSettings } from './Branding.tsx'
import { Usage } from './Usage.tsx'
import { UserDetail, UsersList } from './UsersPage.tsx'
import { WorkspaceDetail, WorkspacesList } from './WorkspacesPage.tsx'
import './admin.css'
import { useBrand } from '../brand.ts'

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
      notify(i18n().t('admin.mode.undone'))
    } catch (err) {
      notify(errorText(err))
    }
  }, [notify])
  return { toast, notify, undo }
}

// API and LiveKit are names; the rest are message keys.
const partNames: Record<HealthPart, { name: string } | { key: MessageKey }> = {
  api: { name: 'API' },
  readSync: { key: msg('admin.mode.part.readSync') },
  livekit: { name: 'LiveKit' },
  sip: { key: msg('admin.mode.part.sip') },
  agent: { key: msg('admin.mode.part.agent') },
  email: { key: msg('admin.mode.part.email') },
}

/** The parts of the install that report a problem, checked when admin opens and every few minutes. */
function useHealthProblems(): string[] {
  const t = useT()
  // The same answer the overview's Health card shows; the overview says when it cannot be read.
  const health = useQuery(ADMIN_HEALTH, loadHealth).data
  useEffect(() => {
    const timer = setInterval(() => void refreshQuery(ADMIN_HEALTH), 5 * 60_000)
    return () => clearInterval(timer)
  }, [])
  if (!health) return []
  // An API older than this page may not report every part yet.
  return (Object.keys(partNames) as HealthPart[])
    .filter(k => health[k] && !health[k].ok)
    .map(k => {
      const part = partNames[k]
      return 'name' in part ? part.name : t(part.key)
    })
}

type Props = { currentUserId: string; onExit: () => void }

export function AdminMode({ currentUserId, onExit }: Props) {
  const t = useT()
  const format = useFormat()
  const { place, go } = useAdminPlace()
  const { name: productName } = useBrand()
  const { lists, providers, data, listsError, providersError, reload } = useAdminData()
  const { toast, notify, undo } = useAdminToast()
  const listKeys = useRef<ListKeys | null>(null)
  const problems = useHealthProblems()
  // One status for the overview's card and Server admin › Providers: tested once, shown the same on both.
  const status = useProviderStatus(providers)
  // The session stopped opening Admin while it was open (1 hour without a passkey): sign in again here.
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  // Where a page puts its own buttons, at the right of its heading (Providers: Show all providers).
  const [headActions, setHeadActions] = useState<HTMLDivElement | null>(null)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])
  // Runs before the app's own key handler, which belongs to the inbox.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘K and ? would open the inbox's palette and help sheet, which admin mode does not show.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return swallow(e)
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) return
      // An open form (a confirmation, a key form, Add user) handles its own keys: Esc cancels it.
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
      const section = /^\d$/.test(e.key) ? adminSections[sectionIndexOfKey(e.key)] : undefined
      let handled = true
      if (e.key === 'Escape') {
        const up = placeUp(place)
        up ? go(up) : onExit()
      } else if (section) go({ section: section.id, id: null })
      // Tab moves between sections only from the page itself, as it moves between views in the inbox; on a
      // button, link or menu it walks focus as everywhere else (Q11).
      else if (e.key === 'Tab') {
        if (!tabSwitchesSection(document.activeElement)) return
        go({ section: nextSection(place.section, e.shiftKey), id: null })
      }
      // Z only ever undoes here: the inbox's undo would act on a call out of sight.
      else if (e.key === 'z') void undo()
      // M and ? would open the inbox's menu and help, / its search: here / searches the list.
      else if (e.key === 'm' || e.key === '?') handled = true
      else handled = (isListPlace(place) && (listKeys.current?.(e.key) ?? false)) || e.key === '/'
      if (handled) swallow(e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [place, go, onExit, undo])

  const meta = adminSections.find(s => s.id === place.section)!
  const open = (id: string) => go({ section: place.section, id })
  const shared = { notify, reload }
  const workspace =
    place.section === 'workspaces' && place.id ? lists?.workspaces.find(w => w.id === place.id) : undefined
  const user = place.section === 'users' && place.id ? lists?.users.find(u => u.id === place.id) : undefined
  const billTitle = useBillTitle(place.section === 'billing' ? place.id : null)
  const detailTitle = workspace?.name ?? (user ? user.name || user.email : billTitle)
  // The crumb names where it goes: a bill goes up to Billing › Bills, everything else to its section.
  const up = placeUp(place)
  const crumb = (place.section === 'billing' && billingPartTitle(t, up?.id ?? null)) || t(meta.label)
  const viewerWorkspaces = new Set(lists?.users.find(u => u.id === currentUserId)?.workspaces.map(w => w.id))

  function page(): ReactNode {
    // The overview and Onboarding load their own numbers, so they show while the lists are still on their way.
    if (place.section === 'overview')
      return (
        <>
          <SecondPasskeyNote account={currentUserId} />
          <StatusCard status={status} />
          <Overview onOpen={section => go({ section, id: null })} />
        </>
      )
    if (place.section === 'onboarding') return <Onboarding />
    // Billing loads its own rows (the bills, the Stripe events), and says itself when a bill is not found.
    if (place.section === 'billing')
      return <Billing id={place.id} onOpen={open} notify={notify} keysRef={listKeys} data={data} />
    // Pages that load their own data never wait for the lists or the providers.
    if (place.section === 'branding') return <BrandingSettings />
    if (place.section === 'calls') return <CallSettings data={data} status={status} reload={reload} notify={notify} />
    if (place.section === 'numbers') return <GermanNumbers />
    if (place.section === 'signup') return <SignupSettings notify={notify} />
    if (place.section === 'tools') return <ToolSettings />
    if (place.section === 'server') return <Server status={status} />
    if (place.section === 'prompt') return <SystemPrompt />
    if (place.section === 'partners') return <Partners notify={notify} waiting={place.id === 'waiting'} />
    if (place.section === 'call-reviews') return <CallReviews />
    // Providers needs both parts; every other page only the lists, which come back first.
    const ready = place.section === 'providers' ? data : lists
    if (!ready)
      return (
        <div className="adm-card adm-listcard">
          <Loading
            what={t('shell.page.admin')}
            loading
            error={place.section === 'providers' ? (listsError ?? providersError) : listsError}
            onRetry={() => void reload()}
            skeleton={<SkeletonRows rows={6} columns={4} className="adm-sk-rows" />}
          />
        </div>
      )
    // Providers' ids are groups and providers (Providers.tsx), not rows.
    if (place.id && !detailTitle && place.section !== 'providers')
      return <p className="adm-notice">{t('admin.mode.notFound')}</p>
    switch (place.section) {
      case 'workspaces':
        return workspace ? (
          <WorkspaceDetail
            workspace={workspace}
            users={ready.users}
            onDeleted={() => go({ section: 'workspaces', id: null })}
            viewerWorkspaces={viewerWorkspaces}
            currentUserId={currentUserId}
            {...shared}
          />
        ) : (
          <WorkspacesList
            workspaces={ready.workspaces}
            onOpen={open}
            keysRef={listKeys}
            viewerWorkspaces={viewerWorkspaces}
            {...shared}
          />
        )
      case 'users':
        return user ? (
          <UserDetail user={user} workspaces={ready.workspaces} currentUserId={currentUserId} {...shared} />
        ) : (
          <UsersList
            users={ready.users}
            workspaces={ready.workspaces}
            currentUserId={currentUserId}
            onOpen={open}
            keysRef={listKeys}
            {...shared}
          />
        )
      case 'usage':
        return <Usage workspaces={ready.workspaces} usage={ready.usage} months={ready.usageMonths} />
      case 'providers':
        return data ? (
          <Providers
            data={data}
            status={status}
            id={place.id}
            onClearId={() => go({ section: 'providers', id: null })}
            headActions={headActions}
            {...shared}
          />
        ) : null
      case 'audit':
        // Support access emails sit next to the log of every sign-in as a user, not under Branding.
        return (
          <>
            <ImpersonationEmails />
            <AuditLog workspaces={ready.workspaces} />
          </>
        )
    }
  }

  // After signing in, the page loads again at the same admin address (SecondFactorPrompt).
  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onExit} />

  const sections = adminSections.map((s, i) => ({
    id: s.id,
    label: t(s.label),
    group: 'group' in s ? t(adminGroups[s.group]) : undefined,
    shortcut: sectionKey(i),
    mark:
      s.id === 'overview' && problems.length > 0 ? (
        <StatusMark
          state="failing"
          className="adm-nav-mark"
          label={t('admin.mode.needsAttention', { parts: format.list(problems, { type: 'unit', style: 'short' }) })}
        />
      ) : undefined,
  }))

  return (
    <div className="adm-mode">
      <div className="pagebar">
        <Button
          size="sm"
          variant="ghost"
          icon="left"
          className="adm-back"
          aria-label={t('admin.frame.back', { brand: productName })}
          title={t('common.withKey', { label: t('admin.frame.back', { brand: productName }), key: 'esc' })}
          onClick={onExit}
        />
        <b>{t('shell.page.admin')}</b>
      </div>
      <div className="page">
        <SettingsLayout page="admin" title={t('shell.page.admin')} sections={sections} current={place.section}>
          <header className="adm-head">
            {detailTitle ? (
              <>
                <button
                  type="button"
                  className="adm-crumb"
                  onClick={() => go(up ?? { section: place.section, id: null })}
                  title={t('common.withKey', { label: t('admin.frame.backTo', { section: crumb }), key: 'esc' })}
                >
                  <Icon name="left" size={13} />
                  {crumb}
                </button>
                <h2>{detailTitle}</h2>
              </>
            ) : (
              <>
                <div className="adm-head-row">
                  <h2>{t(meta.label)}</h2>
                  <div className="adm-head-actions" ref={setHeadActions} />
                </div>
                {meta.description && <p>{t(meta.description)}</p>}
              </>
            )}
          </header>
          {/* A provider or group link on Providers stays on the same page: it scrolls or opens a dialog. */}
          <div
            className={place.section === 'providers' ? 'adm-body adm-body-wide' : 'adm-body'}
            key={place.section === 'providers' ? place.section : `${place.section}/${place.id ?? ''}`}
          >
            {page()}
          </div>
        </SettingsLayout>
      </div>
      {toast && <Toast toast={{ text: toast.text, undo: !!toast.undo }} onUndo={() => void undo()} />}
      {/* Last, so the passkey dialog opens over a confirm dialog that waits for it (same layer, later wins). */}
      <PasskeyStepUpHost />
    </div>
  )
}

/** For someone who opens an admin address without being a server admin. */
export function AdminNotice() {
  const t = useT()
  return (
    <div className="page">
      <div className="page-in">
        <div className="empty">
          <b>{t('admin.mode.notice.title')}</b>
          <span>{t('admin.mode.notice.body')}</span>
        </div>
      </div>
    </div>
  )
}
