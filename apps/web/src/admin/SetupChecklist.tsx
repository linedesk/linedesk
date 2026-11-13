// Admin, Overview, on top: the instance setup checklist. One row per part a first answered call needs, with its
// live state, a short guide for the provider we recommend, the rough cost and a Test (the providers' own
// connection tests). Connect opens the same dialog as Admin, Providers. Folds into one line once every part works.
import { openAgentSetup } from '../onboarding/AgentSetup.tsx'
import { openInstallSetup } from '../onboarding/InstallSetup.tsx'
import {
  type SetupChecklist as Checklist,
  oneKey,
  type ProviderCategory,
  type ProviderName,
  providerSpec,
  providersIn,
  type SetupChecklistItem,
  type SetupItemState,
  setupItemSpec,
  type TryOutData,
  type TryOutKind,
} from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { FormField, SecretInput } from '../ui/form.tsx'
import { Button, cx, Icon, Spinner } from '../ui/kit.tsx'
import { LoadProblem, problemText } from '../ui/LoadStates.tsx'
import {
  ADMIN_SETUP_CHECKLIST,
  type AdminData,
  keyUsersOf,
  loadInstallSetup,
  loadSetupChecklist,
  runAdmin,
  testProvider,
} from './api.ts'
import { errorText, type Notify } from './notify.ts'
import { ProviderDialog } from './ProviderDialog.tsx'

export const stateWords: Record<SetupItemState, string> = {
  ok: 'Works',
  set_up: 'Not tested',
  failing: 'Failing',
  missing: 'Missing',
}

/** The row's state at a glance: a tick, a "!", a half-done ring, or the step's number while it is still to do. */
export function StatusMark({ state, index }: { state: SetupItemState | 'checking'; index: number }) {
  return (
    <span className={cx('adm-mark', state)} aria-hidden="true">
      {state === 'checking' ? (
        <Spinner />
      ) : state === 'ok' ? (
        <Icon name="check" size={12} />
      ) : state === 'failing' ? (
        '!'
      ) : state === 'missing' ? (
        index
      ) : null}
    </span>
  )
}

const voiceItems = ['stt', 'llm', 'tts'] as const
/**
 * Rows whose Test is a real round trip (provider.tryOut): a caller's question to the model, a sample call transcribed,
 * the voice spoken (and played), numbers listed. Email's needs a code typed back, so it lives in the install setup;
 * the tests when the page opens stay the providers' own key checks (provider.test), which cost nothing.
 */
const tryKinds: readonly string[] = ['llm', 'stt', 'tts', 'telephony'] satisfies TryOutKind[]
export const ADMIN_INSTALL_SETUP = 'admin.installSetup'

/**
 * The item's message, with the provider in front unless the message names it already.
 * LIN-111: a failing item shows providerFailureReasonLabels[reason] before its message once the checklist reads the
 * recorded failures (GET /v1/admin/providers `failures`, the test's `reason`).
 */
const messageOf = ({ providerLabel, coveredBy, message }: SetupChecklistItem) =>
  providerLabel && !coveredBy && message?.startsWith(`${providerLabel}: `)
    ? message.slice(providerLabel.length + 2)
    : message

/** Keys on the admin overview, for the row in focus (else the first part that does not work yet). */
const KEYS = { test: 't', connect: 'c', steps: 's', fold: 'h' } as const
const isTyping = (el: Element | null) =>
  !!el &&
  (el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable)

/** Speech, model and voice that no provider covers yet: the one-key offer is for them. */
export const emptyVoiceCategories = (items: readonly SetupChecklistItem[]): ProviderCategory[] =>
  items.filter(i => (voiceItems as readonly string[]).includes(i.id) && !i.provider).map(i => i.id as ProviderCategory)

type Props = { data: AdminData | null; notify: Notify; reload: () => Promise<void> }

export function SetupChecklist({ data, notify, reload }: Props) {
  const query = useQuery(ADMIN_SETUP_CHECKLIST, () => loadSetupChecklist())
  // The install setup by hand: offered next to the agent while it is on (not on Cloud) and not finished.
  const install = useQuery(ADMIN_INSTALL_SETUP, () => loadInstallSetup()).data
  const checklist = query.data ?? null
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<boolean | null>(null)
  const [dialog, setDialog] = useState<ProviderName | null>(null)
  /** Rows whose steps are shown; the first part that does not work starts open. */
  const [guides, setGuides] = useState<Set<string> | null>(null)
  /** The row the keys act on: the one last focused or hovered. */
  const [current, setCurrent] = useState<SetupChecklistItem['id'] | null>(null)
  /** A test that could not run, in its row; a checklist that could not be read again, above the rows. */
  const [rowProblems, setRowProblems] = useState<Map<string, string>>(new Map())
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null)
  const autoTested = useRef(false)

  const put = (next: Checklist) => setQueryData(ADMIN_SETUP_CHECKLIST, next)
  async function refresh() {
    try {
      put(await loadSetupChecklist())
      setRefreshProblem(null)
    } catch (err) {
      setRefreshProblem(problemText(errorText(err)))
    }
  }
  const setRowProblem = (ids: readonly string[], text: string | null) =>
    setRowProblems(m => {
      const next = new Map(m)
      for (const id of ids) text ? next.set(id, text) : next.delete(id)
      return next
    })

  /**
   * Tests each provider once (provider.test, logged like every admin action); rows sharing it share the result. A test
   * that could not run (the server did not answer, the admin sign-in ran out) says so in its rows, never silently.
   */
  async function testProviders(items: readonly SetupChecklistItem[]) {
    const providers = [...new Set(items.flatMap(i => (i.provider ? [i.provider] : [])))]
    if (!providers.length) return
    const rowsOf = (p: ProviderName) => checklist?.items.filter(i => i.provider === p).map(i => i.id) ?? []
    const rows = providers.flatMap(rowsOf)
    setTesting(t => new Set([...t, ...rows]))
    setRowProblem(rows, null)
    const results = await Promise.allSettled(providers.map(p => testProvider(p)))
    results.forEach((result, i) => {
      if (result.status === 'rejected')
        setRowProblem(rowsOf(providers[i]!), `The test could not run: ${problemText(errorText(result.reason))}`)
    })
    await refresh()
    setTesting(t => new Set([...t].filter(id => !rows.includes(id as SetupChecklistItem['id']))))
  }

  // Parts with keys but no result in this API process yet are tested once when the page opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per page, when the first answer is there
  useEffect(() => {
    if (!checklist || autoTested.current) return
    autoTested.current = true
    void testProviders(checklist.items.filter(i => i.state === 'set_up'))
  }, [checklist])

  // T, C, S and H, like the rest of Admin's keys: not while typing, in a form or with a dialog open.
  const keyAction = useRef<(key: string) => boolean>(() => false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('[role="dialog"]') || document.activeElement?.closest('form')) return
      if (isTyping(document.activeElement)) return
      if (!keyAction.current(e.key.toLowerCase())) return
      // Handled here: the app's own key handler (the inbox's) must not act on it too.
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    // After Admin's own key handler (registered first, also capturing), before the app's.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!checklist)
    return query.error ? (
      <LoadProblem
        className="adm-card"
        what="The setup checklist"
        message={query.error}
        onRetry={() => void query.reload()}
      />
    ) : null

  const expanded = open ?? !checklist.complete
  // The steps are how to set a part up: open for the first part that is not set up yet. A part that is set up but
  // failing (a used-up quota) says its fix in its message, so its sign-up steps stay closed.
  const firstOpen = checklist.items.find(i => i.state === 'missing')?.id ?? null
  const shownGuides = guides ?? new Set(firstOpen ? [firstOpen] : [])
  const toggleGuide = (id: string) =>
    setGuides(() => {
      const next = new Set(shownGuides)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  /** The row's round trip; the result is remembered for the row's provider, so reading the checklist shows it. */
  async function tryOut(item: SetupChecklistItem) {
    setTesting(t => new Set(t).add(item.id))
    setRowProblem([item.id], null)
    try {
      const result = (await runAdmin('provider.tryOut', { kind: item.id as TryOutKind })) as TryOutData
      if (result.audio) void new Audio(result.audio).play().catch(() => {})
      if (result.numbers?.length) notify(`Available: ${result.numbers.join(', ')}. Nothing was bought.`)
    } catch (err) {
      setRowProblem([item.id], `The test could not run: ${problemText(errorText(err))}`)
    }
    await refresh()
    setTesting(t => new Set([...t].filter(id => id !== item.id)))
  }

  async function test(item: SetupChecklistItem) {
    if (item.provider && tryKinds.includes(item.id)) return tryOut(item)
    if (item.provider) return testProviders([item])
    // LiveKit: reading the checklist again asks it.
    setTesting(t => new Set(t).add(item.id))
    await refresh()
    setTesting(t => new Set([...t].filter(id => id !== item.id)))
  }

  /** Where Connect goes for a row: the provider in use, else the one its steps are for. */
  const targetOf = (item: SetupChecklistItem) => item.provider ?? setupItemSpec(item.id).guide.provider
  const canConnect = !!data && data.canStoreKeys
  keyAction.current = key => {
    if (key === KEYS.fold) {
      setOpen(!expanded)
      return true
    }
    const item = expanded && checklist.items.find(i => i.id === (current ?? firstOpen))
    if (!item) return false
    const target = targetOf(item)
    if (key === KEYS.test && item.state !== 'missing' && !testing.has(item.id)) void test(item)
    else if (key === KEYS.connect && target && canConnect) setDialog(target)
    else if (key === KEYS.steps) toggleGuide(item.id)
    else return false
    return true
  }

  const opened = dialog ? data?.providers.find(p => p.provider === dialog) : undefined
  const reloadBoth = async () => {
    await reload()
    await refresh()
  }

  return (
    <section className="adm-card adm-setup" aria-label="Instance setup">
      <div className="adm-card-head">
        <div>
          <h2>{checklist.complete ? 'Instance setup: every part works' : 'Set up this install'}</h2>
          <p className="help">
            {checklist.ready} of {checklist.items.length} parts work.
            {!checklist.complete && ' What a first answered call needs; each part with its steps and a test.'}
          </p>
          <div className="adm-setup-progress" aria-hidden="true">
            {checklist.items.map(item => (
              <span key={item.id} className={item.state} />
            ))}
          </div>
        </div>
        {!checklist.complete && (
          <Button
            size="sm"
            variant="primary"
            icon="spark"
            onClick={openAgentSetup}
            title="Let Claude, ChatGPT or another AI agent set up this install with you"
          >
            Set up with an AI agent
          </Button>
        )}
        {!checklist.complete && install?.enabled && (
          <Button
            size="sm"
            variant="ghost"
            onClick={openInstallSetup}
            title="Go through each part yourself, one screen at a time, with a real test for each"
          >
            {install.progress.step !== 'welcome' && !install.progress.finishedAt
              ? 'Continue step by step'
              : 'Step by step'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          title={expanded ? 'Fold the checklist (H)' : 'Show the checklist (H)'}
        >
          {expanded ? 'Hide' : 'Show'}
        </Button>
      </div>
      {refreshProblem && (
        <p className="k-field-msg" role="alert">
          The checklist could not be read again. {refreshProblem}{' '}
          <button type="button" className="k-link" onClick={() => void refresh()} title="Read the checklist again">
            Try again
          </button>
        </p>
      )}
      {expanded && (
        <ol className="adm-setup-list">
          {checklist.items.map((item, i) => (
            <SetupRow
              key={item.id}
              index={i + 1}
              item={item}
              checking={testing.has(item.id)}
              problem={rowProblems.get(item.id) ?? null}
              primary={item.id === firstOpen}
              showGuide={shownGuides.has(item.id)}
              target={targetOf(item)}
              canConnect={canConnect}
              onFocus={() => setCurrent(item.id)}
              onTest={() => void test(item)}
              onConnect={provider => setDialog(provider)}
              onSteps={() => toggleGuide(item.id)}
            />
          ))}
        </ol>
      )}
      {expanded && emptyVoiceCategories(checklist.items).length > 0 && (
        <OneKey
          disabled={!data?.canStoreKeys}
          onDone={async () => {
            await reloadBoth()
            notify('Speech, model and voice use OpenAI now.')
          }}
        />
      )}
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
          onTested={() => void refresh()}
          onUse={async () => {
            await runAdmin('provider.setActive', { category: opened.category, provider: opened.provider })
            await reloadBoth()
          }}
          onStopUsing={async () => {
            await runAdmin('provider.setActive', { category: opened.category, provider: null })
            await reloadBoth()
          }}
          reload={reloadBoth}
          notify={notify}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  )
}

type RowProps = {
  /** Its place in the list, shown while it is still to do. */
  index: number
  item: SetupChecklistItem
  checking: boolean
  /** Why the last test could not run (not a failing test: that is the item's state and message). */
  problem: string | null
  /** The first part that does not work: its Connect is the primary button. */
  primary: boolean
  showGuide: boolean
  /** The provider in use (the realtime model when it covers this part), else the one the steps are for. */
  target: ProviderName | null
  canConnect: boolean
  onFocus: () => void
  onTest: () => void
  onConnect: (provider: ProviderName) => void
  onSteps: () => void
}

function SetupRow({
  index,
  item,
  checking,
  problem,
  primary,
  showGuide,
  target,
  canConnect,
  onFocus,
  onTest,
  onConnect,
  onSteps,
}: RowProps) {
  const { guide, why, category } = setupItemSpec(item.id)
  const guideFor = guide.provider ? providerSpec(guide.provider).label : null
  // The steps are for the provider we recommend; every other one the install supports for this part is one click away too.
  const others = category && item.state === 'missing' ? providersIn(category).filter(p => p !== guide.provider) : []
  const stateText = item.id === 'livekit' && item.state === 'set_up' ? 'Partly set up' : stateWords[item.state]
  return (
    <li className="adm-setup-row" onFocus={onFocus} onMouseEnter={onFocus}>
      <div className="adm-setup-line">
        <StatusMark state={checking ? 'checking' : item.state} index={index} />
        <div className="adm-setup-what">
          <div className="adm-setup-title">
            <b>{item.label}</b>
            {item.providerLabel && !item.coveredBy && <span className="adm-setup-prov">{item.providerLabel}</span>}
            <span className="sr-only">: {checking ? 'Testing' : stateText}</span>
          </div>
          <span className={cx('help', !checking && item.state === 'failing' && 'adm-setup-bad')}>
            {checking ? 'Testing…' : item.message ? messageOf(item) : why}
          </span>
          {problem && !checking && (
            <span className="k-field-msg" role="alert">
              {problem}
            </span>
          )}
        </div>
        <div className="adm-setup-actions">
          {item.state !== 'missing' && (
            <Button
              className="a-test"
              size="sm"
              variant="ghost"
              disabled={checking}
              onClick={onTest}
              title={`Test ${item.label} again (T)`}
            >
              {problem ? 'Try again' : 'Test'}
            </Button>
          )}
          {target && (
            <Button
              className="a-keys"
              size="sm"
              variant={primary && item.state === 'missing' ? 'primary' : 'secondary'}
              disabled={!canConnect}
              onClick={() => onConnect(target)}
              title={
                canConnect
                  ? `Enter the ${providerSpec(target).label} keys (C)`
                  : 'Keys cannot be saved until SECRETS_KEY is set in .env'
              }
            >
              {item.state === 'missing' ? `Connect ${providerSpec(target).label}` : 'Edit keys'}
            </Button>
          )}
          <Button
            className="a-steps"
            size="sm"
            variant="ghost"
            aria-expanded={showGuide}
            onClick={onSteps}
            title={showGuide ? 'Hide the steps (S)' : 'Show the steps (S)'}
          >
            Steps
            <Icon name={showGuide ? 'up' : 'down'} size={14} />
          </Button>
        </div>
      </div>
      {showGuide && (
        <div className="adm-setup-guide">
          <ol>
            {guide.steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="help">
            <a href={guide.url} target="_blank" rel="noreferrer">
              {guideFor ? `Open ${guideFor}` : 'Ports and firewall'}
            </a>
            {' · '}
            {guide.cost}
          </p>
          {others.length > 0 && (
            <p className="help adm-setup-others">
              Already have an account elsewhere? Connect{' '}
              {others.map((p, i) => (
                <span key={p}>
                  {i > 0 && (i === others.length - 1 ? ' or ' : ', ')}
                  <button type="button" className="k-link" disabled={!canConnect} onClick={() => onConnect(p)}>
                    {providerSpec(p).label}
                  </button>
                </span>
              ))}
              .
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function OneKey({ disabled, onDone }: { disabled: boolean; onDone: () => Promise<void> }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function use() {
    setBusy(true)
    setProblem(null)
    try {
      // One server action: the key is tested first and only stored when it works; a failing key changes nothing.
      // LIN-111: show providerFailureText(reason, 'OpenAI', 'admin') once the action answers with the test's reason.
      await runAdmin('provider.connectOneKey', { apiKey: key.trim() })
      setKey('')
      await onDone()
    } catch (err) {
      setProblem(problemText(errorText(err)))
    } finally {
      setBusy(false)
    }
  }
  const ready = !disabled && !busy && !!key.trim()
  return (
    <div className="adm-setup-onekey">
      <b>Or use one key for speech, model and voice</b>
      <p className="help">
        An {oneKey.label} key covers all three, so the first call needs two accounts instead of four. {oneKey.caveat}{' '}
        {oneKey.cost}
      </p>
      <ol className="adm-setup-guide-steps">
        {oneKey.steps.map(step => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <form
        className="adm-setup-onekey-form"
        onSubmit={e => {
          e.preventDefault()
          if (key.trim() && !busy) void use()
        }}
      >
        <FormField id="adm-onekey" label="OpenAI API key">
          <SecretInput id="adm-onekey" value={key} onChange={setKey} placeholder="sk-…" />
        </FormField>
        <Button
          busy={busy}
          type="submit"
          variant="primary"
          disabled={!ready}
          title={
            disabled
              ? 'Keys cannot be saved until SECRETS_KEY is set in .env'
              : ready
                ? 'Test the key and use it when it works (Enter)'
                : 'Paste an OpenAI API key first'
          }
        >
          {busy ? 'Connecting…' : 'Use one key'}
        </Button>
      </form>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
      <p className="help">
        <a href={oneKey.url} target="_blank" rel="noreferrer">
          Open OpenAI API keys
        </a>
      </p>
    </div>
  )
}
