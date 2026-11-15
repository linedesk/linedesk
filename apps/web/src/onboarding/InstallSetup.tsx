// Install setup by hand (LIN-128, docs/self-host-first-run.md): the small alternative to setting up with an AI agent
// (AgentSetup.tsx). One screen per provider group a first answered call needs, in the order of Server admin ›
// Providers: each step is its heading, the same group panel as Server admin › Providers (ProviderGroup, embedded: it
// opens the provider's dialog in place and never navigates away) and the footer. The dialog has Test again and Try it, a real
// round trip (`provider.tryOut`). Welcome and Done show the "Ready for calls" list. Where the admin got to is kept on
// the server (`install.setProgress`), so it resumes there. An admin without a passkey adds one before Email
// (PasskeyFirst, LIN-189): email and sign-in keys need it.
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
import { T, useT } from '@linedesk/i18n/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
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
import { forgetEnrolmentCode, readEnrolmentCode } from '../enrolment-code.ts'
import { passkeySupported } from '../auth.ts'
import { addPasskey, confirmWithPasskey } from '../settings/account/account-api.ts'
import { describeDevice } from '../settings/account/account-model.ts'
import { Input } from '../ui/form.tsx'
import { HelpTip, type HelpTipContent } from '../ui/HelpTip.tsx'
import { BrandMark, Button, Note } from '../ui/kit.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type PasskeyHere, PasskeyFirstStep, usePasskeyHere } from './AddPasskeyStep.tsx'
import type { PasskeyStep } from './agent-setup-passkey.ts'
import { leaveInstallSetup } from './leave-install-setup.ts'
import { showPasskeyFirst } from './passkey-first.ts'
import { Loading, problemText, SkeletonFields } from '../ui/LoadStates.tsx'
import { HostingNote, openAgentSetup } from './AgentSetup.tsx'
import '../admin/admin.css'
import './agent-setup.css'
import './install-setup.css'

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

/** The screen the walkthrough opens on. The welcome screen is the first run's intro; Back from Email still reaches it. */
export function openingStep(progress: InstallSetupState['progress'], from: InstallSetupFrom): InstallStep {
  if (from === 'start') return partSteps[0]!
  return progress.finishedAt ? 'done' : progress.step
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
  const t = useT()
  const from = useRef(openFrom)
  useEffect(() => {
    openFrom = 'left'
  }, [])
  const [setup, setSetup] = useState<InstallSetupState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState<InstallStep | null>(null)
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  // "Skip for now" on the passkey screen: Email shows, and its save asks for the passkey then (PasskeyStepUp).
  const [passkeySkipped, setPasskeySkipped] = useState(false)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])
  // Step 1 on the welcome screen: the passkey added right there shows as done at once, then the setup is read again.
  const [passkeyAddedHere, setPasskeyAddedHere] = useState(false)
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
        // Off on this install (Cloud): Server admin › Providers is the way by hand.
        if (!s.enabled) window.location.hash = '#admin/providers'
        setStep(current => current ?? openingStep(s.progress, from.current))
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
  const passkey = usePasskeyHere(
    useCallback(() => {
      setPasskeyAddedHere(true)
      void reloadAll()
    }, [reloadAll]),
    reloadAll,
  )

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
  const partIndex = step ? partSteps.indexOf(step as PartStepId) : -1
  const groups = status.status?.groups ?? null
  const passkeyFirst = showPasskeyFirst(step, setup, passkeySkipped)
  const passkeyStep: PasskeyStep = passkeyAddedHere ? 'done' : setup?.passkeyNeeded ? 'todo' : 'none'
  return (
    <div className="ob is" role="main" aria-label={t('onboarding.install.label', { brand: brandName() })}>
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">
          {passkeyFirst
            ? t('onboarding.install.countStep', { step: t('onboarding.install.welcome.passkey') })
            : !step
              ? t('onboarding.install.count')
              : partIndex >= 0
                ? t('onboarding.install.countStepOf', {
                    step: installStepLabels[step],
                    number: partIndex + 1,
                    total: partSteps.length,
                  })
                : t('onboarding.install.countStep', { step: installStepLabels[step] })}
        </span>
        <Button size="sm" variant="ghost" onClick={later} title={t('onboarding.install.laterTip')}>
          {t('onboarding.install.later')}
        </Button>
      </div>
      <div className="ob-bar">
        <span style={{ width: `${Math.round((index / (installSteps.length - 1)) * 100)}%` }} />
      </div>
      <div className="ob-main as-main">
        {!setup || !step || !data || !groups ? (
          <Loading
            what={t('onboarding.install.loading')}
            loading
            error={loadError}
            skeleton={<SkeletonFields fields={2} />}
          />
        ) : step === 'welcome' ? (
          <Welcome status={status} passkeyStep={passkeyStep} passkey={passkey} onStart={() => go('email')} />
        ) : passkeyFirst ? (
          <PasskeyFirst
            onBack={() => go('welcome')}
            onSkip={() => setPasskeySkipped(true)}
            onDone={async () => {
              await reloadAll()
            }}
          />
        ) : step === 'done' ? (
          <Done
            status={status}
            skipped={setup.progress.skipped}
            onBack={() => go(installSteps[index - 1]!)}
            onOpen={step => go(step)}
            onFinish={finish}
          />
        ) : (
          <PartStep
            key={step}
            step={step as PartStepId}
            number={partIndex + 1}
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

function Foot({
  onBack,
  onSkip,
  skipTitle,
  onNext,
  nextLabel,
  nextPrimary = true,
}: {
  onBack?: () => void
  onSkip?: () => void
  skipTitle?: string
  onNext: () => void
  nextLabel?: string
  nextPrimary?: boolean
}) {
  const t = useT()
  return (
    <div className="ob-foot">
      {onBack ? (
        <Button variant="ghost" icon="left" onClick={onBack} title={t('onboarding.action.backTip')}>
          {t('onboarding.action.back')}
        </Button>
      ) : (
        <span />
      )}
      <div className="ob2-foot-r">
        {onSkip && (
          <Button variant="ghost" onClick={onSkip} title={skipTitle}>
            {t('onboarding.action.skipForNow')}
          </Button>
        )}
        <Button variant={nextPrimary ? 'primary' : 'secondary'} shortcut={['⏎']} onClick={onNext}>
          {nextLabel ?? t('onboarding.action.continue')}
        </Button>
      </div>
    </div>
  )
}

const groupOfStep = (status: ProviderStatusState, step: PartStepId) =>
  status.status!.groups.find(g => g.id === installStepGroups[step])!

function Welcome({
  status,
  passkeyStep,
  passkey,
  onStart,
}: {
  status: ProviderStatusState
  /** `none`: the admin has one already (or this install asks for none): no passkey step. */
  passkeyStep: Exclude<PasskeyStep, 'loading'>
  passkey: PasskeyHere
  onStart: () => void
}) {
  const t = useT()
  useWalkKeys(onStart, null)
  const passkeyFirst = passkeyStep !== 'none'
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.install.welcome.title')}</h1>
        <p className="ob-lede">
          {passkeyFirst ? t('onboarding.install.welcome.ledePasskey') : t('onboarding.install.welcome.lede')}
        </p>
      </div>
      <HostingNote address={window.location.origin} />
      {/* The same step 1 as the agent setup page: add the passkey right here; the parts follow. */}
      {passkeyFirst && (
        <section className="as-card" aria-label={t('onboarding.install.welcome.steps')}>
          <ol className="as-steps">
            <PasskeyFirstStep step={passkeyStep} passkey={passkey} />
            <li className={passkeyStep === 'done' ? undefined : 'as-later'}>
              <b>{t('onboarding.install.welcome.parts')}</b>
              <span className="as-small">{t('onboarding.install.welcome.partsHelp')}</span>
            </li>
          </ol>
        </section>
      )}
      <section className="as-card">
        {passkeyFirst && (
          <div className="adm-health is-passkey-row">
            <div className="adm-health-row">
              <StatusMark state={passkeyStep === 'done' ? 'works' : 'missing'} />
              <b>{t('onboarding.install.welcome.passkey')}</b>
              <span className="help">
                {passkeyStep === 'done'
                  ? t('onboarding.install.passkey.added')
                  : t('onboarding.install.passkey.notAdded')}
              </span>
            </div>
          </div>
        )}
        <StatusList groups={status.status!.groups} links={false} />
      </section>
      <Note tone="info">
        <T k="onboarding.install.agentNote" values={BOLD} />{' '}
        <button type="button" className="k-link" onClick={openAgentSetup} title={t('onboarding.install.agentTip')}>
          {t('onboarding.install.agentButton')}
        </button>
      </Note>
      <Foot onNext={onStart} nextLabel={t('onboarding.install.welcome.start')} nextPrimary={passkeyStep !== 'todo'} />
    </>
  )
}

/**
 * Before Email, for an admin without a passkey: email and sign-in keys need one. Add it (the first admin's enrolment
 * code came back with the setup and is filled in), then sign in with it once, so saving those keys just works.
 */
function PasskeyFirst({
  onBack,
  onSkip,
  onDone,
}: {
  onBack: () => void
  onSkip: () => void
  onDone: () => Promise<void>
}) {
  const t = useT()
  const [code, setCode] = useState(() => readEnrolmentCode() ?? '')
  // Filled in from the setup: the field stays hidden unless that code is missing or did not work.
  const [askCode, setAskCode] = useState(() => !readEnrolmentCode())
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = passkeySupported()

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const add = () =>
    run(async () => {
      if (!code.trim()) {
        setAskCode(true)
        throw new Error(t('onboarding.install.passkey.codeMissing'))
      }
      try {
        await addPasskey(describeDevice(navigator.userAgent), code)
      } catch (e) {
        setAskCode(true)
        throw e
      }
      forgetEnrolmentCode()
      setAdded(true)
    })
  const signIn = () =>
    run(async () => {
      await confirmWithPasskey()
      await onDone()
    })
  const primary = !supported ? onSkip : added ? () => void signIn() : () => void add()
  useWalkKeys(busy ? null : primary, onBack)

  return (
    <>
      <div className="ob-body">
        <span className="as-kicker">{t('onboarding.install.passkey.kicker')}</span>
        <h1>{t('onboarding.install.passkey.title')}</h1>
        <p className="ob-lede">{t('onboarding.install.passkey.lede')}</p>
      </div>

      <section className="as-card">
        <ul className="is-passkey">
          <li>
            <StatusMark
              state={added ? 'works' : 'missing'}
              label={added ? t('onboarding.install.passkey.added') : t('onboarding.install.passkey.notAdded')}
            />
            {t('onboarding.install.passkey.addHere')}
          </li>
          <li>
            <StatusMark state="missing" label={t('onboarding.install.passkey.notYet')} />
            {t('onboarding.install.passkey.signInOnce')}
          </li>
        </ul>
        {askCode && !added && (
          <Input
            aria-label={t('onboarding.install.passkey.codeLabel')}
            placeholder={t('onboarding.install.passkey.codeLabel')}
            value={code}
            onChange={e => setCode(e.target.value)}
            end={
              <HelpTip
                inField
                label={t('onboarding.install.passkey.codeWhere')}
                {...enrolmentCodeHelp(
                  t('onboarding.install.passkey.codeHelp'),
                  t('onboarding.install.passkey.codeAfter'),
                )}
              />
            }
          />
        )}
        {!supported && <Note tone="danger">{t('onboarding.install.passkey.needsHttps')}</Note>}
        {error && <Note tone="danger">{error}</Note>}
      </section>

      <div className="ob-foot">
        <Button variant="ghost" icon="left" onClick={onBack} title={t('onboarding.action.backTip')}>
          {t('onboarding.action.back')}
        </Button>
        <div className="ob2-foot-r">
          {supported && (
            <Button variant="ghost" onClick={onSkip} title={t('onboarding.install.passkey.skipTip')}>
              {t('onboarding.action.skipForNow')}
            </Button>
          )}
          <Button variant="primary" shortcut={['⏎']} disabled={busy} onClick={primary}>
            {t(
              busy
                ? 'onboarding.install.passkey.waiting'
                : !supported
                  ? 'onboarding.action.skipForNow'
                  : added
                    ? 'onboarding.install.passkey.signIn'
                    : 'onboarding.install.passkey.add',
            )}
          </Button>
        </div>
      </div>
    </>
  )
}

/** A new enrolment code, made on the server (apps/api/src/user-passkeys.ts); the command stays as it is typed. */
const enrolmentCodeHelp = (text: string, after: string): HelpTipContent => ({
  text,
  commands: [{ code: 'docker compose exec api node apps/api/src/user-passkeys.ts --enrol --email <your email>' }],
  after,
})

/** `<b>…</b>` in a message. */
const BOLD = { b: (chunks: ReactNode[]) => <b>{chunks}</b> }

type PartProps = {
  step: PartStepId
  number: number
  data: AdminData
  status: ProviderStatusState
  setup: InstallSetupState
  reloadAll: () => Promise<void>
  onBack: () => void
  onNext: () => void
  onSkip: () => void
}

/** One group: its heading, the same panel as Server admin › Providers, and the footer. */
function PartStep({ step, number, data, status, setup, reloadAll, onBack, onNext, onSkip }: PartProps) {
  const t = useT()
  const group = groupOfStep(status, step)
  const [dialog, setDialog] = useState<ProviderName | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const emailByLog = step === 'email' && setup.emailDelivery === 'log'
  const ready = group.state !== 'missing' || emailByLog
  useWalkKeys(ready ? onNext : null, onBack)

  return (
    <>
      <div className="ob-body">
        <span className="as-kicker">{t('onboarding.install.part.stepOf', { number, total: partSteps.length })}</span>
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

      <Foot
        onBack={onBack}
        onSkip={ready && group.state !== 'works' ? onSkip : undefined}
        skipTitle={t('onboarding.install.skipTip', {
          part: group.label,
          effect: installSkipEffects[step] ?? '',
        }).trim()}
        onNext={ready ? onNext : onSkip}
        nextLabel={ready ? t('onboarding.action.continue') : t('onboarding.action.skipForNow')}
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
        <StatusList groups={status.status!.groups} links={false} />
      </section>
      {open.length > 0 && (
        <ul className="is-remaining">
          {open.map(s => (
            <li key={s}>
              <T
                k={
                  skipped.includes(s) ? 'onboarding.install.done.remainingSkipped' : 'onboarding.install.done.remaining'
                }
                values={{
                  part: installStepLabels[s],
                  effect: installSkipEffects[s],
                  link: chunks => (
                    <button type="button" className="k-link" onClick={() => onOpen(s)}>
                      {chunks}
                    </button>
                  ),
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {/* A hint, not a link: the walkthrough never leaves itself (Server admin has no way back to this step). */}
      <Note tone="info">{t('onboarding.install.done.later')}</Note>
      <Foot onBack={onBack} onNext={onFinish} nextLabel={t('onboarding.install.done.next')} />
    </>
  )
}
