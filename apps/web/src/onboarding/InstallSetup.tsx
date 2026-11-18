// Install setup by hand (LIN-128, docs/self-host-first-run.md): the small alternative to setting up with an AI agent
// (AgentSetup.tsx). One screen per provider group a first answered call needs, in the order of Server admin ›
// Providers: each step is its heading, the same group panel as Server admin › Providers (ProviderGroup, embedded: it
// opens the provider's dialog in place and never navigates away) and the footer. The dialog has Test again and Try it, a real
// round trip (`provider.tryOut`). Welcome and Done list the four parts in the agent page's rows (a mark where a part
// works; on Done a way back to each part that does not). Only the four parts are counted ("Step n of 4"); Welcome and
// Done say "By hand" in the top bar. Where the admin got to is kept on
// the server (`install.setProgress`), so it resumes there. It opens only after the passkey check of Server admin
// (SecondFactorPrompt), so the admin has a passkey here already (LIN-248).
import {
  groupSpec,
  type InstallSetupState,
  type InstallStep,
  installStepGroups,
  installSteps,
  type ProviderName,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { type AdminData, reloadAdminData, loadInstallSetup, runAdmin, watchAdminSignIn } from '../admin/api.ts'
import { errorText } from '../admin/notify.ts'
import { PasskeyStepUpHost } from '../admin/PasskeyStepUp.tsx'
import { ProviderGroup } from '../admin/ProviderGroup.tsx'
import { ProviderDialogFor } from '../admin/Providers.tsx'
import { type ProviderStatusState, useProviderStatus } from '../admin/providerStatus.ts'
import { useAdminData } from '../admin/useAdminData.ts'
import { SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import { TryOut } from '../admin/TryOut.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { Button, cx, Note } from '../ui/kit.tsx'
import { MarkGlyph } from '../ui/StatusMark.tsx'
import { leaveInstallSetup } from './leave-install-setup.ts'
import { Loading, problemText, SkeletonFields } from '../ui/LoadStates.tsx'
import { HostingNote, openAgentSetup } from './AgentSetup.tsx'
import { SetupFoot } from './SetupFoot.tsx'
import { SetupTopBar } from './SetupTopBar.tsx'
import '../admin/admin.css'
import './agent-setup.css'

export const INSTALL_SETUP_HASH = '#setup-install'
/**
 * Where the walkthrough opens: `start`, its first part (Email), for "Step by step", which always starts over on the
 * screens and changes nothing saved; `left` (default), where the admin left it ("Continue step by step"), or its
 * overview once finished.
 */
export type InstallSetupFrom = 'start' | 'left'
// Read by the walkthrough when it opens (the address stays `#setup-install`).
let openFrom: InstallSetupFrom = 'left'
export const openInstallSetup = ({ from = 'left' }: { from?: InstallSetupFrom } = {}) => {
  openFrom = from
  window.location.hash = INSTALL_SETUP_HASH
}

/** Each step's name in the reader's language (installStepLabels in @linedesk/actions is the English for the CLI). */
const stepLabelKeys: Record<InstallStep, MessageKey> = {
  welcome: msg('onboarding.install.step.welcome'),
  email: msg('onboarding.install.step.email'),
  answering: msg('onboarding.install.step.answering'),
  telephony: msg('onboarding.install.step.telephony'),
  'call-audio': msg('onboarding.install.step.callAudio'),
  done: msg('onboarding.install.step.done'),
}

/** What does not work when a step is skipped (installSkipEffects), in the reader's language. */
const skipEffectKeys: Partial<Record<InstallStep, MessageKey>> = {
  email: msg('onboarding.install.skipEffect.email'),
  answering: msg('onboarding.install.skipEffect.answering'),
  telephony: msg('onboarding.install.skipEffect.telephony'),
  'call-audio': msg('onboarding.install.skipEffect.callAudio'),
}

/** The screen the walkthrough opens on. The welcome screen is the first run's intro; Back from Email still reaches it. */
export function openingStep(progress: InstallSetupState['progress'], from: InstallSetupFrom): InstallStep {
  if (from === 'start') return partSteps[0]!
  return progress.finishedAt ? 'done' : progress.step
}

/** The steps that set up a group, in order (the welcome and done screens around them). */
type PartStepId = Exclude<InstallStep, 'welcome' | 'done'>
const partSteps = installSteps.filter(s => installStepGroups[s]) as PartStepId[]
const RESTART_POLL_MS = 2500

/**
 * The top bar of a walkthrough screen: only the four parts are counted (`part`: "Step 2 of 4 · Answering calls"),
 * Welcome and Done have none (the bar says "By hand"); the line runs from the welcome (empty) to Done (full).
 */
export function installTopBar(step: InstallStep): { part: { n: number; m: number } | null; progress: number } {
  const at = partSteps.indexOf(step as PartStepId)
  return {
    part: at >= 0 ? { n: at + 1, m: partSteps.length } : null,
    progress: Math.round((installSteps.indexOf(step) / (installSteps.length - 1)) * 100),
  }
}

type Props = {
  /** Leave the walkthrough: on to the business setup, or the app as it is. */
  onExit: () => void
  /**
   * Back to the agent setup page (App.tsx): in the top bar of every step but the last, as in the business setup's frame
   * (Frame.tsx). Without it (a first run in no workspace yet), the agent page opens by its address.
   */
  onAgentSetup?: () => void
}

export function InstallSetup({ onExit, onAgentSetup }: Props) {
  const t = useT()
  const from = useRef(openFrom)
  useEffect(() => {
    openFrom = 'left'
  }, [])
  const [setup, setSetup] = useState<InstallSetupState | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [step, setStep] = useState<InstallStep | null>(null)
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])
  // Shared with Server admin: what one loads, the other shows at once.
  const adminData = useAdminData()
  const data = adminData.data
  const adminError = adminData.listsError ?? adminData.providersError
  const loadError = data ? setupError : (setupError ?? (adminError && problemText(errorText(adminError))))
  const status = useProviderStatus(adminData.providers)

  const loadSetup = useCallback(async () => {
    const next = await loadInstallSetup()
    setSetup(next)
    setSetupError(null)
    return next
  }, [])
  useEffect(() => {
    loadSetup().then(
      s => {
        // Off on this install (Cloud): Server admin › Providers is the way by hand.
        if (!s.enabled) window.location.hash = '#admin/providers'
        setStep(current => current ?? openingStep(s.progress, from.current))
      },
      e => setSetupError(problemText(errorText(e))),
    )
  }, [loadSetup])

  const reloadAll = useCallback(async () => {
    await Promise.all([reloadAdminData(), loadSetup().catch(() => null)])
  }, [loadSetup])

  // A saved sign-in change waits for a restart: read again until the API runs with it. Email applies at once.
  const pending = setup?.restart.pending ?? false
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => {
      loadInstallSetup().then(
        next => {
          setSetup(next)
          if (!next.restart.pending) void reloadAll()
        },
        // The API is restarting: it answers again in a few seconds.
        () => {},
      )
    }, RESTART_POLL_MS)
    return () => clearInterval(id)
  }, [pending, reloadAll])

  const save = (change: Parameters<typeof runAdmin<'install.setProgress'>>[1]) =>
    runAdmin('install.setProgress', change).catch(() => {
      // Where the admin is stays on this page; the next step saves it again.
    })
  const go = (next: InstallStep, skipped?: InstallStep) => {
    setStep(next)
    void save({ step: next, ...(skipped ? { skip: skipped } : {}) })
    // The page is its own scroll box (.ob): the next step starts at its top.
    document.querySelector('.ob.is')?.scrollTo({ top: 0 })
  }
  // Leaving never waits for the server (its save carries on): a slow one made both buttons look dead.
  const later = () => leaveInstallSetup(save, { setAside: true }, onExit)
  const finish = () => leaveInstallSetup(save, { finished: true, step: 'done' }, onExit)

  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onExit} />

  const index = step ? installSteps.indexOf(step) : 0
  const groups = status.status?.groups ?? null
  const bar = step ? installTopBar(step) : { part: null, progress: 0 }
  return (
    <div className="ob is" role="main" aria-label={t('onboarding.install.label', { brand: brandName() })}>
      <SetupTopBar
        step={bar.part && step ? { ...bar.part, name: t(stepLabelKeys[step]) } : undefined}
        label={bar.part ? undefined : t('onboarding.install.count')}
        progress={bar.progress}
        agentPath={step === 'done' ? undefined : (onAgentSetup ?? openAgentSetup)}
        // Done is the end of the walkthrough: its own button goes on, there is nothing to finish later.
        exit={step === 'done' ? null : { kind: 'finish-later', onExit: later, title: t('onboarding.install.laterTip') }}
      />
      <div className="ob-main as-main">
        {!setup || !step || !data || !groups ? (
          <Loading
            what={t('onboarding.install.loading')}
            loading
            error={loadError}
            skeleton={<SkeletonFields fields={2} />}
          />
        ) : step === 'welcome' ? (
          <Welcome status={status} onStart={() => go('email')} />
        ) : step === 'done' ? (
          <Done
            status={status}
            onBack={() => go(installSteps[index - 1]!)}
            onOpen={step => go(step)}
            onFinish={finish}
          />
        ) : (
          <PartStep
            key={step}
            step={step as PartStepId}
            data={data}
            status={status}
            setup={setup}
            reloadAll={reloadAll}
            onBack={() => go(installSteps[index - 1]!)}
            onNext={() => go(installSteps[index + 1]!)}
            onSkip={() => go(installSteps[index + 1]!, step)}
          />
        )}
      </div>
      {/* Last, so the passkey dialog opens over the provider dialog that waits for it (same layer, later wins). */}
      <PasskeyStepUpHost />
    </div>
  )
}

/** Enter continues and Esc goes back, except in a form, a field or an open dialog (they handle their own keys). */
function useWalkKeys(onEnter: (() => void) | null, onEscape: (() => void) | null) {
  const ref = useRef({ onEnter, onEscape })
  ref.current = { onEnter, onEscape }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (document.querySelector('[role="dialog"]')) return
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('form') || active?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'Escape' && ref.current.onEscape) {
        e.preventDefault()
        ref.current.onEscape()
      } else if (e.key === 'Enter' && ref.current.onEnter && !active?.matches('button, a')) {
        e.preventDefault()
        ref.current.onEnter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const groupOfStep = (status: ProviderStatusState, step: PartStepId) =>
  status.status!.groups.find(g => g.id === installStepGroups[step])!

function Welcome({ status, onStart }: { status: ProviderStatusState; onStart: () => void }) {
  const t = useT()
  useWalkKeys(onStart, null)
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.install.welcome.title')}</h1>
        <p className="ob-lede">{t('onboarding.install.welcome.lede')}</p>
      </div>
      <HostingNote address={window.location.origin} />
      <section className="as-card">
        <Parts status={status} />
      </section>
      {/* The way to the agent is the top bar's "Set up with an AI agent", as on every step. */}
      <Note tone="info">
        <T k="onboarding.install.agentNote" values={BOLD} />
      </Note>
      <SetupFoot onContinue={onStart} label={t('onboarding.install.welcome.start')} />
    </>
  )
}

/** `<b>…</b>` in a message. */
const BOLD = { b: (chunks: ReactNode[]) => <b>{chunks}</b> }

/**
 * The four parts in the agent page's rows (agent-setup.css `.as-list`): a filled mark and the provider in use where a
 * part works. `onOpen` (Done): each part that does not work says what is missing without it and has a way back to it.
 */
function Parts({ status, onOpen }: { status: ProviderStatusState; onOpen?: (step: PartStepId) => void }) {
  const t = useT()
  return (
    <ul className="as-list">
      {partSteps.map(s => {
        const group = groupOfStep(status, s)
        const works = group.state === 'works'
        const failing = group.state === 'failing'
        const effect = !works && onOpen && skipEffectKeys[s] ? t(skipEffectKeys[s]) : null
        return (
          <li key={s} className={cx('as-item', works && 'done', failing && 'failing')}>
            <span className="as-mark" aria-hidden>
              {works ? <MarkGlyph kind="works" size={12} /> : failing ? <MarkGlyph kind="partly" size={12} /> : null}
            </span>
            <span className="as-item-label">
              {t(stepLabelKeys[s])}
              {works && group.providerLabel && <span className="as-hint"> · {group.providerLabel}</span>}
              {effect && <span className="as-hint as-hint-line">{effect}</span>}
            </span>
            {!works && onOpen && (
              <span className="as-item-action">
                <Button size="sm" variant="secondary" onClick={() => onOpen(s)}>
                  {t('onboarding.install.done.setUp')}
                </Button>
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

type PartProps = {
  step: PartStepId
  data: AdminData
  status: ProviderStatusState
  setup: InstallSetupState
  reloadAll: () => Promise<void>
  onBack: () => void
  onNext: () => void
  onSkip: () => void
}

/** One group: its heading, the same panel as Server admin › Providers, and the footer. */
function PartStep({ step, data, status, setup, reloadAll, onBack, onNext, onSkip }: PartProps) {
  const t = useT()
  const group = groupOfStep(status, step)
  const [dialog, setDialog] = useState<ProviderName | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const emailByLog = step === 'email' && setup.emailDelivery === 'log'
  const ready = group.state !== 'missing' || emailByLog
  useWalkKeys(ready ? onNext : null, onBack)
  const skipTitle = t('onboarding.install.skipTip', {
    part: group.label,
    effect: skipEffectKeys[step] ? t(skipEffectKeys[step]) : '',
  }).trim()

  return (
    <>
      <div className="ob-body">
        <h1>{group.label}</h1>
        <p className="ob-lede">{t(groupSpec(group.id).whyKey)}</p>
      </div>

      <ProviderGroup
        group={group}
        data={data}
        lines={status.status!.lines}
        health={status.health}
        onOpen={setDialog}
        onOneKey={async () => {
          await reloadAll()
          setNote(t('onboarding.install.oneKeyDone'))
        }}
        embedded
      />

      {/* No email provider in development: codes go to the API log, and Try it shows they do. */}
      {emailByLog && group.state === 'missing' && <TryOut kind="email" primary={false} onTried={reloadAll} />}

      {note && (
        <p className="as-small" role="status">
          {note}
        </p>
      )}

      {/* Not set up yet: the quiet "Later" goes on, Continue (and Enter) waits for the part to work. */}
      <SetupFoot
        onBack={onBack}
        backTitle={t('onboarding.action.backTip')}
        onSkipStep={group.state !== 'works' ? onSkip : undefined}
        laterTitle={skipTitle}
        onContinue={onNext}
        canContinue={ready}
      />

      {dialog && (
        <ProviderDialogFor
          name={dialog}
          data={data}
          status={status}
          reload={reloadAll}
          notify={text => setNote(text)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

function Done({
  status,
  onBack,
  onOpen,
  onFinish,
}: {
  status: ProviderStatusState
  onBack: () => void
  onOpen: (step: InstallStep) => void
  onFinish: () => void
}) {
  const t = useT()
  useWalkKeys(onFinish, onBack)
  const open = partSteps.filter(s => groupOfStep(status, s).state !== 'works')
  return (
    <>
      <div className="ob-body">
        <h1>{open.length ? t('onboarding.install.done.almost') : t('onboarding.install.done.title')}</h1>
        <p className="ob-lede">
          {open.length ? t('onboarding.install.done.almostLede') : t('onboarding.install.done.titleLede')}
        </p>
      </div>
      <section className="as-card">
        <Parts status={status} onOpen={onOpen} />
      </section>
      {/* A hint, not a link: the walkthrough never leaves itself (Server admin has no way back to this step). */}
      <Note tone="info">{t('onboarding.install.done.later')}</Note>
      <SetupFoot
        onBack={onBack}
        backTitle={t('onboarding.action.backTip')}
        onContinue={onFinish}
        label={t('onboarding.install.done.next')}
      />
    </>
  )
}
