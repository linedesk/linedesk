// Install setup by hand (LIN-128, docs/self-host-first-run.md): the small alternative to setting up with an AI agent
// (AgentSetup.tsx). One screen per provider group a first answered call needs, in the order of Admin › Providers:
// each step is its heading, the same group panel as Admin › Providers (ProviderGroup, embedded: it opens the
// provider's dialog in place and never navigates away) and the footer. The dialog has Test again and Try it, a real
// round trip (`provider.tryOut`). Welcome and Done show the "Ready for calls" list. Where the admin got to is kept on
// the server (`install.setProgress`), so it resumes there.
import {
  groupSpec,
  type InstallSetupState,
  type InstallStep,
  installSkipEffects,
  installStepGroups,
  installStepLabels,
  installSteps,
  type ProviderName,
} from '@linedesk/actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ADMIN_DATA,
  type AdminData,
  loadAdminData,
  loadInstallSetup,
  runAdmin,
  watchAdminSignIn,
} from '../admin/api.ts'
import { errorText } from '../admin/notify.ts'
import { PasskeyStepUpHost } from '../admin/PasskeyStepUp.tsx'
import { ProviderGroup } from '../admin/ProviderGroup.tsx'
import { ProviderDialogFor } from '../admin/Providers.tsx'
import { type ProviderStatusState, useProviderStatus } from '../admin/providerStatus.ts'
import { SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import { StatusList } from '../admin/StatusCard.tsx'
import { TryOut } from '../admin/TryOut.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { peekQuery, setQueryData } from '../cachedQuery.ts'
import { BrandMark, Button, Note, Spinner } from '../ui/kit.tsx'
import { problemText } from '../ui/LoadStates.tsx'
import { HostingNote, openAgentSetup } from './AgentSetup.tsx'
import '../admin/admin.css'
import './agent-setup.css'
import './install-setup.css'

export const INSTALL_SETUP_HASH = '#setup-install'
export const openInstallSetup = () => {
  window.location.hash = INSTALL_SETUP_HASH
}

/** The steps that set up a group, in order (the welcome and done screens around them). */
type PartStepId = Exclude<InstallStep, 'welcome' | 'done'>
const partSteps = installSteps.filter(s => installStepGroups[s]) as PartStepId[]
const RESTART_POLL_MS = 2500

type Props = {
  /** Leave the walkthrough: on to the business setup, or the app as it is. */
  onExit: () => void
}

export function InstallSetup({ onExit }: Props) {
  const [setup, setSetup] = useState<InstallSetupState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState<InstallStep | null>(null)
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])
  // Read here and shared with Admin's cache (the page opens before the session settles the cache's scope, so a cached
  // read could miss its answer).
  const [data, setData] = useState<AdminData | null>(() => peekQuery(ADMIN_DATA) ?? null)
  const status = useProviderStatus(data)

  const loadSetup = useCallback(async () => {
    const next = await loadInstallSetup()
    setSetup(next)
    setLoadError(null)
    return next
  }, [])
  useEffect(() => {
    loadSetup().then(
      s => {
        // Off on this install (Cloud): Admin › Providers is the way by hand.
        if (!s.enabled) window.location.hash = '#admin/providers'
        setStep(current => current ?? (s.progress.finishedAt ? 'done' : s.progress.step))
      },
      e => setLoadError(problemText(errorText(e))),
    )
  }, [loadSetup])

  const reloadData = useCallback(async () => {
    const next = await loadAdminData()
    setData(next)
    setQueryData(ADMIN_DATA, next)
  }, [])
  useEffect(() => {
    reloadData().catch(e => setLoadError(problemText(errorText(e))))
  }, [reloadData])
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadData(), loadSetup().catch(() => null)])
  }, [reloadData, loadSetup])

  // A saved email or sign-in change waits for a restart: read again until the API runs with it.
  const [restarting, setRestarting] = useState(false)
  const pending = setup?.restart.pending ?? false
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => {
      loadInstallSetup().then(
        next => {
          setRestarting(false)
          setSetup(next)
          if (!next.restart.pending) void reloadAll()
        },
        // The API is restarting: it answers again in a few seconds.
        () => setRestarting(true),
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
  const later = async () => {
    await save({ setAside: true })
    onExit()
  }
  const finish = async () => {
    await save({ finished: true, step: 'done' })
    onExit()
  }

  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onExit} />

  const index = step ? installSteps.indexOf(step) : 0
  const partIndex = step ? partSteps.indexOf(step as PartStepId) : -1
  const groups = status.status?.groups ?? null
  return (
    <div className="ob is" role="main" aria-label={`Set up ${brandName()} by hand`}>
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">
          Setup by hand{step ? ` · ${installStepLabels[step]}` : ''}
          {partIndex >= 0 ? ` · ${partIndex + 1} of ${partSteps.length}` : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void later()}
          title="Leave now and pick up where you left off in Admin › Providers"
        >
          Set up later
        </Button>
      </div>
      <div className="ob-bar">
        <span style={{ width: `${Math.round((index / (installSteps.length - 1)) * 100)}%` }} />
      </div>
      <div className="ob-main as-main">
        {!setup || !step || !data || !groups ? (
          loadError ? (
            <Note tone="danger">{loadError}</Note>
          ) : (
            <p className="as-small">
              <Spinner /> Loading the setup…
            </p>
          )
        ) : step === 'welcome' ? (
          <Welcome status={status} onStart={() => go('email')} />
        ) : step === 'done' ? (
          <Done
            status={status}
            skipped={setup.progress.skipped}
            onBack={() => go(installSteps[index - 1]!)}
            onOpen={step => go(step)}
            onFinish={() => void finish()}
          />
        ) : (
          <PartStep
            key={step}
            step={step as PartStepId}
            number={partIndex + 1}
            data={data}
            status={status}
            setup={setup}
            restarting={restarting}
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

function Foot({
  onBack,
  onSkip,
  skipTitle,
  onNext,
  nextLabel = 'Continue',
  nextPrimary = true,
}: {
  onBack?: () => void
  onSkip?: () => void
  skipTitle?: string
  onNext: () => void
  nextLabel?: string
  nextPrimary?: boolean
}) {
  return (
    <div className="ob-foot">
      {onBack ? (
        <Button variant="ghost" icon="left" onClick={onBack} title="Back (Esc)">
          Back
        </Button>
      ) : (
        <span />
      )}
      <div className="ob2-foot-r">
        {onSkip && (
          <Button variant="ghost" onClick={onSkip} title={skipTitle}>
            Skip for now
          </Button>
        )}
        <Button variant={nextPrimary ? 'primary' : 'secondary'} shortcut={['⏎']} onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
    </div>
  )
}

const groupOfStep = (status: ProviderStatusState, step: PartStepId) =>
  status.status!.groups.find(g => g.id === installStepGroups[step])!

function Welcome({ status, onStart }: { status: ProviderStatusState; onStart: () => void }) {
  useWalkKeys(onStart, null)
  return (
    <>
      <div className="ob-body">
        <h1>Set up this server by hand</h1>
        <p className="ob-lede">
          Four parts, most with their own account. Every step says where to get the key and what it costs, and tests it
          for real before you move on. About 30 to 45 minutes; you can skip a part and come back to it.
        </p>
      </div>
      <HostingNote address={window.location.origin} />
      <section className="as-card">
        <StatusList groups={status.status!.groups} links={false} />
      </section>
      <Note tone="info">
        An AI agent can do this in <b>about 15 minutes</b> and check the server for you.{' '}
        <button
          type="button"
          className="k-link"
          onClick={openAgentSetup}
          title="Set up with Claude, ChatGPT or another agent"
        >
          Set up with an AI agent instead
        </button>
      </Note>
      <Foot onNext={onStart} nextLabel="Start" />
    </>
  )
}

type PartProps = {
  step: PartStepId
  number: number
  data: AdminData
  status: ProviderStatusState
  setup: InstallSetupState
  restarting: boolean
  reloadAll: () => Promise<void>
  onBack: () => void
  onNext: () => void
  onSkip: () => void
}

/** One group: its heading, the same panel as Admin › Providers, and the footer. */
function PartStep({ step, number, data, status, setup, restarting, reloadAll, onBack, onNext, onSkip }: PartProps) {
  const group = groupOfStep(status, step)
  const [dialog, setDialog] = useState<ProviderName | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const emailByLog = step === 'email' && setup.emailDelivery === 'log'
  const waiting = step === 'email' && setup.restart.pending
  const ready = group.state !== 'missing' || emailByLog
  useWalkKeys(ready ? onNext : null, onBack)

  return (
    <>
      <div className="ob-body">
        <span className="as-kicker">
          Step {number} of {partSteps.length}
        </span>
        <h1>{group.label}</h1>
        <p className="ob-lede">{groupSpec(group.id).why}</p>
      </div>

      <ProviderGroup
        group={group}
        data={data}
        lines={status.status!.lines}
        health={status.health}
        onOpen={setDialog}
        onOneKey={async () => {
          await reloadAll()
          setNote('Calls are answered with OpenAI now.')
        }}
        embedded
      />

      {waiting && (
        <Note role="status">
          {setup.restart.automatic ? (
            <>
              <Spinner /> {restarting ? 'Restarting the server' : 'Waiting for the server to restart'} so it uses the
              new email settings. This takes a few seconds.
            </>
          ) : (
            <>
              Email settings are read when the API starts. Restart the API (with pnpm dev, stop it and start it again);
              this page continues on its own once the API is running with the new settings.
            </>
          )}
        </Note>
      )}

      {/* No email provider in development: codes go to the API log, and Try it shows they do. */}
      {emailByLog && group.state === 'missing' && !waiting && (
        <TryOut kind="email" primary={false} onTried={reloadAll} />
      )}

      {note && (
        <p className="as-small" role="status">
          {note}
        </p>
      )}

      <Foot
        onBack={onBack}
        onSkip={ready && group.state !== 'works' ? onSkip : undefined}
        skipTitle={`Skip ${group.label} for now. ${installSkipEffects[step] ?? ''}`}
        onNext={ready ? onNext : onSkip}
        nextLabel={ready ? 'Continue' : 'Skip for now'}
        nextPrimary={ready}
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
  skipped,
  onBack,
  onOpen,
  onFinish,
}: {
  status: ProviderStatusState
  skipped: readonly InstallStep[]
  onBack: () => void
  onOpen: (step: InstallStep) => void
  onFinish: () => void
}) {
  useWalkKeys(onFinish, onBack)
  const open = partSteps.filter(s => groupOfStep(status, s).state !== 'works')
  return (
    <>
      <div className="ob-body">
        <h1>{open.length ? 'The server is almost set up' : 'The server is set up'}</h1>
        <p className="ob-lede">
          {open.length
            ? 'The remaining parts are in Admin › Providers. Next: your business, its assistant and its number.'
            : 'Every part works. Next: your business, its assistant and its number; then call it to hear it answer.'}
        </p>
      </div>
      <section className="as-card">
        <StatusList groups={status.status!.groups} links={false} />
      </section>
      {open.length > 0 && (
        <ul className="is-remaining">
          {open.map(s => (
            <li key={s}>
              <button type="button" className="k-link" onClick={() => onOpen(s)}>
                {installStepLabels[s]}
              </button>
              {skipped.includes(s) ? ' (skipped)' : ''}: {installSkipEffects[s]}
            </li>
          ))}
        </ul>
      )}
      {/* A hint, not a link: the walkthrough never leaves itself (Admin has no way back to this step). */}
      <Note tone="info">
        Sign-in with Google or GitHub, calendars for bookings and where call recordings are kept come later, in Admin ›
        Providers. None of them is needed to answer a first call.
      </Note>
      <Foot onBack={onBack} onNext={onFinish} nextLabel="Set up your business" />
    </>
  )
}
