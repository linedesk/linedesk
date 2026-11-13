// Install setup by hand (LIN-128, docs/self-host-first-run.md): the small alternative to setting up with an AI agent
// (AgentSetup.tsx). One screen per part a first answered call needs, in that order: the same guide, keys dialog and
// state as the setup checklist (Admin › Overview), and a real round trip for each (`provider.tryOut`): a code emailed
// to the admin and typed back, a caller's question to the model, a sample call transcribed, the voice played, numbers
// listed without buying. Where the admin got to is kept on the server (`install.setProgress`), so it resumes there.
import {
  type InstallSetupState,
  type InstallStep,
  installSkipEffects,
  installStepItems,
  installStepLabels,
  installSteps,
  type ProviderCategory,
  type ProviderName,
  providerSpec,
  providersIn,
  type SetupChecklist,
  type SetupChecklistItem,
  setupItemSpec,
  type TryOutData,
  type TryOutKind,
} from '@linedesk/actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ADMIN_DATA,
  ADMIN_SETUP_CHECKLIST,
  type AdminData,
  keyUsersOf,
  loadAdminData,
  loadInstallSetup,
  loadSetupChecklist,
  runAdmin,
  watchAdminSignIn,
} from '../admin/api.ts'
import { errorText } from '../admin/notify.ts'
import { PasskeyStepUpHost } from '../admin/PasskeyStepUp.tsx'
import { ProviderDialog } from '../admin/ProviderDialog.tsx'
import { SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import { emptyVoiceCategories, OneKey, StatusMark, stateWords } from '../admin/SetupChecklist.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { peekQuery, setQueryData } from '../cachedQuery.ts'
import { Input } from '../ui/form.tsx'
import { BrandMark, Button, cx, Icon, Note, Spinner } from '../ui/kit.tsx'
import { problemText } from '../ui/LoadStates.tsx'
import { HostingNote, openAgentSetup } from './AgentSetup.tsx'
import '../admin/admin.css'
import './agent-setup.css'
import './install-setup.css'

export const INSTALL_SETUP_HASH = '#setup-install'
export const openInstallSetup = () => {
  window.location.hash = INSTALL_SETUP_HASH
}

/** The steps that set up a part, in order (the welcome, optional and done screens around them). */
const partSteps = installSteps.filter(s => installStepItems[s]) as Exclude<InstallStep, 'welcome' | 'extras' | 'done'>[]
const RESTART_POLL_MS = 2500

const tryLabels: Record<TryOutKind, string> = {
  email: 'Send me a test email',
  llm: 'Ask it a caller’s question',
  stt: 'Transcribe a sample call',
  tts: 'Hear the voice',
  telephony: 'Find available numbers',
}
const tryHelp: Record<TryOutKind, string> = {
  email:
    'Sends a six-digit code to your own address. Enter it here to confirm emails actually arrive, not just that they are sent.',
  llm: 'Asks the current model a short question a caller might ask, and shows the answer and how long it took.',
  stt: 'Transcribes a short sample recording and checks the result against what was said.',
  tts: 'Plays the greeting a caller would hear, right here in the page.',
  telephony: 'Looks up three available numbers in an area code. Nothing is purchased.',
}

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
  const [checklist, setChecklist] = useState<SetupChecklist | null>(() => peekQuery(ADMIN_SETUP_CHECKLIST) ?? null)
  const [data, setData] = useState<AdminData | null>(() => peekQuery(ADMIN_DATA) ?? null)

  const loadSetup = useCallback(async () => {
    const next = await loadInstallSetup()
    setSetup(next)
    setLoadError(null)
    return next
  }, [])
  useEffect(() => {
    loadSetup().then(
      s => {
        // Off on this install (Cloud): the setup checklist is the way by hand.
        if (!s.enabled) window.location.hash = '#admin'
        setStep(current => current ?? (s.progress.finishedAt ? 'done' : s.progress.step))
      },
      e => setLoadError(problemText(errorText(e))),
    )
  }, [loadSetup])

  const refreshChecklist = useCallback(async () => {
    const next = await loadSetupChecklist()
    setChecklist(next)
    setQueryData(ADMIN_SETUP_CHECKLIST, next)
  }, [])
  const reloadData = useCallback(async () => {
    const next = await loadAdminData()
    setData(next)
    setQueryData(ADMIN_DATA, next)
  }, [])
  useEffect(() => {
    refreshChecklist().catch(e => setLoadError(problemText(errorText(e))))
    // Without it only the keys dialogs wait; the steps show.
    reloadData().catch(() => {})
  }, [refreshChecklist, reloadData])
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadData(), refreshChecklist(), loadSetup().catch(() => null)])
  }, [reloadData, refreshChecklist, loadSetup])

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
  const partIndex = step ? partSteps.indexOf(step as (typeof partSteps)[number]) : -1
  return (
    <div className="ob is" role="main" aria-label={`Set up ${brandName()} by hand`}>
      <PasskeyStepUpHost />
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
          title="Leave now and pick up where you left off in Admin › Overview"
        >
          Set up later
        </Button>
      </div>
      <div className="ob-bar">
        <span style={{ width: `${Math.round((index / (installSteps.length - 1)) * 100)}%` }} />
      </div>
      <div className="ob-main as-main">
        {!setup || !step || !checklist ? (
          loadError ? (
            <Note tone="danger">{loadError}</Note>
          ) : (
            <p className="as-small">
              <Spinner /> Loading the setup…
            </p>
          )
        ) : step === 'welcome' ? (
          <Welcome checklist={checklist} onStart={() => go('email')} />
        ) : step === 'extras' ? (
          <Extras checklist={checklist} onBack={() => go('telephony')} onNext={() => go('done')} />
        ) : step === 'done' ? (
          <Done
            checklist={checklist}
            skipped={setup.progress.skipped}
            onBack={() => go('extras')}
            onOpen={step => go(step)}
            onFinish={() => void finish()}
          />
        ) : (
          <PartStep
            key={step}
            step={step as (typeof partSteps)[number]}
            number={partIndex + 1}
            checklist={checklist}
            data={data}
            setup={setup}
            restarting={restarting}
            refreshChecklist={refreshChecklist}
            reloadAll={reloadAll}
            onBack={() => go(installSteps[index - 1]!)}
            onNext={() => go(installSteps[index + 1]!)}
            onSkip={() => go(installSteps[index + 1]!, step)}
          />
        )}
      </div>
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

const itemOf = (checklist: SetupChecklist, id: SetupChecklistItem['id']) => checklist.items.find(i => i.id === id)!

function PartList({ checklist, ids }: { checklist: SetupChecklist; ids: readonly SetupChecklistItem['id'][] }) {
  return (
    <ul className="as-list is-parts">
      {ids.map((id, i) => {
        const item = itemOf(checklist, id)
        return (
          <li key={id} className="is-part">
            <StatusMark state={item.state} index={i + 1} />
            <span>
              <b>{item.label}</b> <span className="as-small">{setupItemSpec(id).why}</span>
            </span>
            <span className="as-small is-part-state">
              {item.providerLabel && item.state !== 'missing' ? `${item.providerLabel} · ` : ''}
              {stateWords[item.state]}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Welcome({ checklist, onStart }: { checklist: SetupChecklist; onStart: () => void }) {
  useWalkKeys(onStart, null)
  return (
    <>
      <div className="ob-body">
        <h1>Set up this server by hand</h1>
        <p className="ob-lede">
          Five parts, each with its own account. Every step says where to get the key and what it costs, and tests it
          for real before you move on. About 30 to 45 minutes; you can skip a part and come back to it.
        </p>
      </div>
      <HostingNote address={window.location.origin} />
      <PartList checklist={checklist} ids={partSteps.map(s => installStepItems[s]!)} />
      <Note tone="info">
        An AI agent can do this in about 15 minutes and check the server for you.{' '}
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
  step: (typeof partSteps)[number]
  number: number
  checklist: SetupChecklist
  data: AdminData | null
  setup: InstallSetupState
  restarting: boolean
  refreshChecklist: () => Promise<void>
  reloadAll: () => Promise<void>
  onBack: () => void
  onNext: () => void
  onSkip: () => void
}

function PartStep({
  step,
  number,
  checklist,
  data,
  setup,
  restarting,
  refreshChecklist,
  reloadAll,
  onBack,
  onNext,
  onSkip,
}: PartProps) {
  const id = installStepItems[step]!
  const item = itemOf(checklist, id)
  const spec = setupItemSpec(id)
  const [dialog, setDialog] = useState<ProviderName | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const target = item.provider ?? spec.guide.provider
  const canStore = !!data?.canStoreKeys
  const emailByLog = step === 'email' && setup.emailDelivery === 'log'
  const waiting = step === 'email' && setup.restart.pending
  const ready = item.state !== 'missing' || emailByLog
  const others = spec.category && item.state === 'missing' ? providersIn(spec.category).filter(p => p !== target) : []
  const oneKeyOffer =
    (step === 'llm' || step === 'stt' || step === 'tts') &&
    (emptyVoiceCategories(checklist.items) as string[]).includes(step)
  useWalkKeys(ready ? onNext : null, onBack)

  const opened = dialog ? data?.providers.find(p => p.provider === dialog) : undefined
  return (
    <>
      <div className="ob-body">
        <span className="as-kicker">
          Step {number} of {partSteps.length}
        </span>
        <h1>{item.label}</h1>
        <p className="ob-lede">{spec.why}</p>
      </div>

      <section className="as-card" aria-label={`${item.label} status`}>
        <div className="is-status">
          <StatusMark state={item.state} index={number} />
          <div>
            <b>
              {item.providerLabel && !item.coveredBy ? `${item.providerLabel}: ` : ''}
              {stateWords[item.state]}
            </b>
            {item.message && <span className="as-small">{item.message}</span>}
          </div>
          {target && (
            <Button
              size="sm"
              variant={item.state === 'missing' ? 'primary' : 'secondary'}
              disabled={!canStore}
              onClick={() => setDialog(target)}
              title={
                canStore
                  ? `Enter the ${providerSpec(target).label} keys`
                  : 'Keys cannot be saved until SECRETS_KEY is set in .env'
              }
            >
              {item.provider ? 'Edit keys' : `Connect ${providerSpec(target).label}`}
            </Button>
          )}
        </div>
        {item.state === 'missing' && (
          <div className="adm-setup-guide is-guide">
            <ol>
              {spec.guide.steps.map(s => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="help">
              {spec.guide.provider && (
                <a href={spec.guide.url} target="_blank" rel="noreferrer">
                  Open {providerSpec(spec.guide.provider).label}
                </a>
              )}
              {' · '}
              {spec.guide.cost}
            </p>
            {others.length > 0 && (
              <p className="help">
                Already have an account elsewhere? Connect{' '}
                {others.map((p, i) => (
                  <span key={p}>
                    {i > 0 && (i === others.length - 1 ? ' or ' : ', ')}
                    <button type="button" className="k-link" disabled={!canStore} onClick={() => setDialog(p)}>
                      {providerSpec(p).label}
                    </button>
                  </span>
                ))}
                .
              </p>
            )}
          </div>
        )}
      </section>

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

      {oneKeyOffer && (
        <section className="as-card is-onekey">
          <OneKey
            disabled={!canStore}
            onDone={async () => {
              await reloadAll()
              setNote('Speech, model and voice use OpenAI now.')
            }}
          />
        </section>
      )}

      {ready && !waiting && <TryOut kind={step} primary={item.state !== 'missing'} onTried={refreshChecklist} />}

      {note && (
        <p className="as-small" role="status">
          {note}
        </p>
      )}

      <Foot
        onBack={onBack}
        onSkip={ready && item.state !== 'ok' ? onSkip : undefined}
        skipTitle={`Skip ${item.label} for now. ${installSkipEffects[step] ?? ''}`}
        onNext={ready ? onNext : onSkip}
        nextLabel={ready ? 'Continue' : 'Skip for now'}
        nextPrimary={ready}
      />

      {opened && data && (
        <ProviderDialog
          key={opened.provider}
          provider={opened}
          inUse={data.activeProviders[opened.category].provider === opened.provider}
          chosen={data.activeProviders[opened.category].chosen}
          canUse={data.activeProviders[opened.category].provider !== opened.provider}
          keyUsers={keyUsersOf(data.providers, opened.provider)}
          connected={checklist.items.some(i => i.provider === opened.provider && i.state === 'ok')}
          canStore={data.canStoreKeys}
          onTested={() => void refreshChecklist()}
          onUse={async () => {
            await runAdmin('provider.setActive', { category: opened.category, provider: opened.provider })
            await reloadAll()
          }}
          onStopUsing={async () => {
            await runAdmin('provider.setActive', { category: opened.category as ProviderCategory, provider: null })
            await reloadAll()
          }}
          reload={reloadAll}
          notify={text => setNote(text)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

/** The round trip of a part: one button, and what came back. */
function TryOut({ kind, primary, onTried }: { kind: TryOutKind; primary: boolean; onTried: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TryOutData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [areaCode, setAreaCode] = useState('971')
  const [code, setCode] = useState('')
  const [confirmed, setConfirmed] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setProblem(null)
    setConfirmed(null)
    try {
      const input = kind === 'telephony' ? { kind, areaCode } : { kind }
      setResult((await runAdmin('provider.tryOut', input)) as TryOutData)
      await onTried()
    } catch (e) {
      setProblem(problemText(errorText(e)))
    } finally {
      setBusy(false)
    }
  }
  async function confirm() {
    setBusy(true)
    setProblem(null)
    try {
      const done = (await runAdmin('provider.confirmEmail', { code: code.trim() })) as { message: string }
      setConfirmed(done.message)
      setCode('')
      await onTried()
    } catch (e) {
      setProblem(problemText(errorText(e)))
    } finally {
      setBusy(false)
    }
  }

  const areaOk = /^[2-9]\d\d$/.test(areaCode)
  return (
    <section className="as-card is-try" aria-label="Try it">
      <div className="is-try-head">
        <div>
          <b>Try it</b>
          <span className="as-small">{tryHelp[kind]}</span>
        </div>
        <form
          className="is-try-form"
          onSubmit={e => {
            e.preventDefault()
            if (!busy && (kind !== 'telephony' || areaOk)) void run()
          }}
        >
          {kind === 'telephony' && (
            <Input
              className="is-area"
              aria-label="US area code"
              inputMode="numeric"
              maxLength={3}
              value={areaCode}
              onChange={e => setAreaCode(e.target.value.replace(/\D/g, ''))}
              title="A three-digit US area code"
            />
          )}
          <Button
            type="submit"
            variant={primary && !result?.ok ? 'primary' : 'secondary'}
            busy={busy && !result}
            disabled={busy}
          >
            {result ? 'Try again' : tryLabels[kind]}
          </Button>
        </form>
      </div>

      {result && (
        <div className={cx('is-result', result.ok ? 'ok' : 'bad')} role="status">
          <span className="is-result-mark" aria-hidden>
            {result.ok ? <Icon name="check" size={12} /> : '!'}
          </span>
          <div className="is-result-body">
            <span>{result.message}</span>
            {result.reply && (
              <blockquote className="is-quote">
                <span className="as-small">Caller: Hi, my water heater is leaking. Can someone come out today?</span>
                {result.reply}
              </blockquote>
            )}
            {result.heard !== undefined && (
              <dl className="is-heard">
                <dt>Said</dt>
                <dd>{result.expected}</dd>
                <dt>Heard</dt>
                <dd>{result.heard || '(nothing)'}</dd>
              </dl>
            )}
            {result.audio && (
              // biome-ignore lint/a11y/useMediaCaption: a spoken sample of the voice; its words are on the page
              <audio className="is-audio" controls autoPlay src={result.audio} />
            )}
            {!!result.numbers?.length && (
              <ul className="is-numbers">
                {result.numbers.map(n => (
                  <li key={n}>{formatNumber(n)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {kind === 'email' && result?.ok && !confirmed && (
        <form
          className="is-try-form is-code"
          onSubmit={e => {
            e.preventDefault()
            if (!busy && /^\d{6}$/.test(code.trim())) void confirm()
          }}
        >
          <Input
            className="is-code-input"
            aria-label="The code from the email"
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
          <Button type="submit" variant="primary" busy={busy} disabled={busy || code.trim().length !== 6}>
            Confirm
          </Button>
        </form>
      )}
      {confirmed && (
        <div className="is-result ok" role="status">
          <span className="is-result-mark" aria-hidden>
            <Icon name="check" size={12} />
          </span>
          <span>{confirmed}</span>
        </div>
      )}
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </section>
  )
}

const formatNumber = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}

function Extras({ checklist, onBack, onNext }: { checklist: SetupChecklist; onBack: () => void; onNext: () => void }) {
  useWalkKeys(onNext, onBack)
  const livekit = itemOf(checklist, 'livekit')
  const guide = setupItemSpec('livekit').guide
  return (
    <>
      <div className="ob-body">
        <span className="as-kicker">Optional</span>
        <h1>Real phone calls</h1>
        <p className="ob-lede">
          LiveKit carries the call audio and runs on this server. Browser test calls work without the rest; real phone
          calls need these ports open.
        </p>
      </div>
      <section className="as-card">
        <div className="is-status">
          <StatusMark state={livekit.state} index={1} />
          <div>
            <b>
              {livekit.label}: {livekit.state === 'set_up' ? 'Partly set up' : stateWords[livekit.state]}
            </b>
            {livekit.message && <span className="as-small">{livekit.message}</span>}
          </div>
        </div>
        <div className="adm-setup-guide is-guide">
          <ol>
            {guide.steps.map(s => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="help">
            <a href={guide.url} target="_blank" rel="noreferrer">
              Ports and firewall
            </a>
            {' · '}
            {guide.cost}
          </p>
        </div>
      </section>
      {/* A hint, not a link: the walkthrough never leaves itself (Admin has no way back to this step). */}
      <Note tone="info">
        Sign-in with Google or GitHub, calendars for bookings and where call recordings are kept come later, in Admin ›
        Providers. None of them is needed to answer a first call.
      </Note>
      <Foot onBack={onBack} onNext={onNext} />
    </>
  )
}

function Done({
  checklist,
  skipped,
  onBack,
  onOpen,
  onFinish,
}: {
  checklist: SetupChecklist
  skipped: readonly InstallStep[]
  onBack: () => void
  onOpen: (step: InstallStep) => void
  onFinish: () => void
}) {
  useWalkKeys(onFinish, onBack)
  const open = partSteps.filter(s => itemOf(checklist, installStepItems[s]!).state !== 'ok')
  return (
    <>
      <div className="ob-body">
        <h1>{open.length ? 'The server is almost set up' : 'The server is set up'}</h1>
        <p className="ob-lede">
          {open.length
            ? 'The remaining steps are in Admin › Overview. Next: your business, its assistant and its number.'
            : 'Every part works. Next: your business, its assistant and its number; then call it to hear it answer.'}
        </p>
      </div>
      <PartList checklist={checklist} ids={partSteps.map(s => installStepItems[s]!)} />
      {open.length > 0 && (
        <ul className="is-open">
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
      <Foot onBack={onBack} onNext={onFinish} nextLabel="Set up your business" />
    </>
  )
}
