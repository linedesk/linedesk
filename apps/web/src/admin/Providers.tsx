// Admin, Providers: the connections of the install. A light heading per category, its providers as
// one compact list (logo, name and one status on the left; Connect, or Edit and Disconnect on the right).
// Connect and Edit open the provider's dialog (ProviderDialog), where it is connected, tested and chosen.
// Sign-in and calendar share their OAuth apps: Google and Microsoft are listed under both, with one
// connection. Every provider that is set up is tested when the page opens, so the status says what works now.
import {
  categoryNames,
  isMultiCategory,
  type PipelinesSetUp,
  type ProviderCategory,
  providerCategories,
  type ProviderFailure,
  type ProviderName,
  type ProviderTestData,
  VOICE_PIPELINE_LABELS,
  type VoicePipeline,
} from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { HelpTip } from '../ui/form.tsx'
import { Button, cx, Note } from '../ui/kit.tsx'
import { type ActiveProviders, keyUsersOf, type ProviderStatus, runAdmin, testProvider } from './api.ts'
import { FailingProviders, failingSince } from './FailingProviders.tsx'
import { connectionOf, isConfigured, providerState, type TestState } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { clearOpenRouterReturn, type OpenRouterReturn, peekOpenRouterReturn } from './openrouterAuth.ts'
import { ProviderDialog, ServerSet } from './ProviderDialog.tsx'
import { Logo, providerMeta } from './ProviderLogo.tsx'

type Props = {
  providers: ProviderStatus[]
  active: ActiveProviders
  canStore: boolean
  /** Providers failing now (the API's failure record). */
  failures: readonly ProviderFailure[]
  notify: Notify
  reload: () => Promise<void>
}

/** Changes whenever the keys in effect change, so the provider is tested again. */
const keysSignature = (p: ProviderStatus) => JSON.stringify(p.fields.map(f => [f.source, f.last4, f.value]))

/** Tests every provider that is set up, once per set of keys. */
function useConnectionTests(providers: ProviderStatus[]) {
  const [tests, setTests] = useState<Partial<Record<ProviderName, TestState>>>({})
  const tested = useRef(new Map<ProviderName, string>())
  const fresh = useRef(new Set<ProviderName>())
  useEffect(() => {
    for (const p of providers) {
      if (!isConfigured(p)) continue
      const signature = keysSignature(p)
      if (tested.current.get(p.provider) === signature) continue
      tested.current.set(p.provider, signature)
      // The dialog just tested these keys itself.
      if (fresh.current.delete(p.provider)) continue
      setTests(t => ({ ...t, [p.provider]: 'running' }))
      void testProvider(p.provider)
        .catch(err => ({ ok: false, message: errorText(err) }))
        .then(result => setTests(t => ({ ...t, [p.provider]: result })))
    }
  }, [providers])
  const record = (name: ProviderName, result: ProviderTestData) => {
    fresh.current.add(name)
    setTests(t => ({ ...t, [name]: result }))
  }
  return { tests, record }
}

type TileStatus = { word: string; dot: 'ink' | 'muted' | 'danger' | null; title?: string; detail?: string }

/**
 * One status per tile: Active, Connected, Needs attention (works, but soon will not), Failing, Checking… or Not
 * connected. A failure recorded at run time (a call, an email) shows as Failing until a test on this page passes,
 * which clears it on the server too.
 */
export function tileStatus(
  provider: ProviderStatus,
  test: TestState,
  inUse: boolean,
  failure?: ProviderFailure,
): TileStatus {
  const connection = connectionOf(provider, test)
  if (connection === 'none') return { word: 'Not connected', dot: null }
  if (connection === 'error' && typeof test === 'object')
    return { word: 'Failing', dot: 'danger', title: test.message, detail: test.message }
  if (connection === 'checking')
    return failure
      ? {
          word: 'Failing',
          dot: 'danger',
          title: failure.message,
          detail: `${failure.message} (${failingSince(failure)})`,
        }
      : { word: 'Checking…', dot: null }
  if (typeof test === 'object' && test.status === 'warning')
    return { word: 'Needs attention', dot: 'muted', title: test.message, detail: test.message }
  if (inUse) return { word: 'Active', dot: 'ink' }
  // Recording is off until a store is picked: a store that could be used is not "connected" to anything yet.
  if (provider.category === 'recording')
    return { word: 'Not in use', dot: null, title: 'Calls are not recorded here: Edit, then Record here' }
  return { word: 'Connected', dot: 'muted' }
}

type RowProps = {
  provider: ProviderStatus
  test: TestState
  failure?: ProviderFailure
  inUse: boolean
  canStore: boolean
  onOpen: () => void
  onDisconnect: () => void
}

/**
 * One provider: logo, name and status; Connect when it has no keys, else Edit and Disconnect. Keys from the server's
 * environment cannot be removed here: Disconnect is off for them and says where they are set.
 */
function ProviderRow({ provider, test, failure, inUse, canStore, onOpen, onDisconnect }: RowProps) {
  const status = tileStatus(provider, test, inUse, failure)
  const configured = isConfigured(provider)
  const fromServer = configured && providerState(provider) === 'env'
  return (
    <li className="adm-prov">
      <Logo mark={providerMeta[provider.provider].mark} size={28} />
      <span className="adm-prov-name">
        <b>{provider.label}</b>
        <span className={cx('adm-tile-status', status.dot && `adm-dot-${status.dot}`)} title={status.title}>
          {status.word}
          {fromServer && <ServerSet />}
        </span>
        {status.detail && (
          <span className={cx('adm-prov-detail', status.dot === 'danger' && 'adm-prov-detail-danger')}>
            {status.detail}
          </span>
        )}
      </span>
      <span className="adm-prov-actions">
        {configured ? (
          <>
            <Button size="sm" onClick={onOpen} title={`Edit ${provider.label}`}>
              Edit
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canStore || fromServer}
              onClick={onDisconnect}
              title={
                fromServer
                  ? `${provider.label} is set on the server: remove its variables from the server's .env to disconnect it`
                  : `Disconnect ${provider.label}`
              }
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onOpen} title={`Connect ${provider.label}`}>
            Connect
          </Button>
        )}
      </span>
    </li>
  )
}

/** Sign-in and calendar share their OAuth apps: the calendar section lists the ones that also connect calendars. */
const CALENDAR_APPS: readonly ProviderName[] = ['google', 'microsoft']
type PageSection = { id: string; title: string; category: ProviderCategory; only?: readonly ProviderName[] }
const pageSections: PageSection[] = categoryNames.flatMap((category): PageSection[] =>
  category === 'sign_in'
    ? [
        { id: 'sign_in', title: 'Sign-in', category },
        { id: 'calendar', title: 'Calendar', category, only: CALENDAR_APPS },
      ]
    : [{ id: category, title: providerCategories[category], category }],
)

/**
 * Which ways of answering calls are set up: the realtime model, and the three stages (speech to text, language model,
 * voice). Each assistant picks one under Settings › Assistant; one that is not set up falls back to the other.
 */
function PipelinesNote({ active, failing }: { active: ActiveProviders; failing: ReadonlySet<ProviderName> }) {
  // A provider whose test failed or that failed in use is not set up for this: never shown as working (LIN-111).
  const works = (c: 'realtime' | (typeof STAGE_CATEGORIES)[number]) => {
    const provider = active[c]?.provider
    return !!provider && !failing.has(provider)
  }
  const setUp: PipelinesSetUp = { realtime: works('realtime'), three_stage: STAGE_CATEGORIES.every(works) }
  const name = (c: ProviderCategory) => providerCategories[c].toLowerCase()
  const missing = STAGE_CATEGORIES.filter(c => !active[c]?.provider).map(name)
  const broken = STAGE_CATEGORIES.filter(c => active[c]?.provider && !works(c)).map(name)
  const stages = [
    ...(missing.length ? [`missing ${missing.join(' and ')}`] : []),
    ...(broken.length ? [`${broken.join(' and ')} failing`] : []),
  ].join(', ')
  const state = (pipeline: VoicePipeline) =>
    setUp[pipeline] ? 'set up' : pipeline === 'realtime' && active.realtime?.provider ? 'failing' : 'not set up'
  return (
    <Note tone={setUp.realtime || setUp.three_stage ? 'info' : 'warning'}>
      Answering calls: {VOICE_PIPELINE_LABELS.realtime} {state('realtime')};{' '}
      {VOICE_PIPELINE_LABELS.three_stage.toLowerCase()}{' '}
      {setUp.three_stage ? 'set up' : missing.length < 3 ? stages : 'not set up'}.{' '}
      {setUp.realtime && setUp.three_stage
        ? 'Each assistant picks one under Settings, Assistant (realtime by default).'
        : setUp.realtime || setUp.three_stage
          ? `Every assistant uses the ${(setUp.realtime ? VOICE_PIPELINE_LABELS.realtime : VOICE_PIPELINE_LABELS.three_stage).toLowerCase()}.`
          : 'Calls are not answered until one is set up.'}{' '}
      <HelpTip text="Realtime model: one model listens and speaks (fast, in its own voice). Three stages: speech to text, a language model and a voice of your choice. Both put calls through to a person. With both set up, each assistant chooses." />
    </Note>
  )
}

const STAGE_CATEGORIES = ['stt', 'llm', 'tts'] as const satisfies readonly ProviderCategory[]

export function Providers({ providers, active, canStore, failures, notify, reload }: Props) {
  const { tests, record } = useConnectionTests(providers)
  const failureOf = (name: ProviderName) => failures.find(f => f.provider === name)
  // A test that passed or warned on this page cleared the failure on the server.
  const stillFailing = failures.filter(f => {
    const test = tests[f.provider]
    return !(typeof test === 'object' && test.ok)
  })
  /** Failing now: a recorded failure not cleared on this page, or a test here that failed. */
  const failing = new Set<ProviderName>([
    ...stillFailing.map(f => f.provider),
    ...providers.filter(p => connectionOf(p, tests[p.provider]) === 'error').map(p => p.provider),
  ])
  // Back from "Connect with OpenRouter": its dialog opens and finishes the connection.
  const [oauthReturn] = useState<OpenRouterReturn | null>(() => peekOpenRouterReturn())
  useEffect(clearOpenRouterReturn, [])
  const [open, setOpen] = useState<ProviderName | null>(oauthReturn ? 'openrouter' : null)
  /** The dialog opens on its "Delete the stored keys?" step (Disconnect in the list). */
  const [disconnecting, setDisconnecting] = useState(false)
  const opened = providers.find(p => p.provider === open)
  const openDialog = (provider: ProviderName, confirmDisconnect = false) => {
    setDisconnecting(confirmDisconnect)
    setOpen(provider)
  }

  async function use(category: ProviderCategory, provider: ProviderName | null) {
    const before = active[category].chosen ? active[category].provider : null
    const set = async (next: ProviderName | null) => {
      await runAdmin('provider.setActive', { category, provider: next })
      await reload()
    }
    try {
      await set(provider)
      const label = provider ? providers.find(p => p.provider === provider)!.label : null
      notify(
        label
          ? `${providerCategories[category]} uses ${label} now.`
          : category === 'recording'
            ? 'Calls are not recorded now.'
            : `${providerCategories[category]} uses the default now.`,
        () => set(before),
      )
    } catch (err) {
      notify(errorText(err))
    }
  }

  return (
    <>
      {!canStore && (
        <Note tone="warning">
          No encryption key on the server, so keys can't be saved.{' '}
          <HelpTip text="Whoever runs the server sets SECRETS_KEY (make one with openssl rand -base64 32) and restarts the API. Keys are then saved encrypted." />
        </Note>
      )}
      <FailingProviders failures={stillFailing} />
      <PipelinesNote active={active} failing={failing} />
      {pageSections.map(({ id, title, category, only }) => {
        const inSection = providers.filter(p => p.category === category && (!only || only.includes(p.provider)))
        const { provider: inUse } = active[category]
        return (
          <section key={id} className="adm-provcat" aria-labelledby={`adm-cat-${id}`}>
            <h2 id={`adm-cat-${id}`}>
              {title}
              {category === 'recording' && !inUse && <span className="adm-provcat-note">Off</span>}
              {only && <span className="adm-provcat-note">The same apps as for sign-in: connected once for both</span>}
            </h2>
            <ul className="adm-provlist">
              {inSection.map(p => (
                <ProviderRow
                  key={p.provider}
                  provider={p}
                  test={tests[p.provider]}
                  failure={failureOf(p.provider)}
                  inUse={isMultiCategory(category) ? isConfigured(p) : inUse === p.provider}
                  canStore={canStore}
                  onOpen={() => openDialog(p.provider)}
                  onDisconnect={() => openDialog(p.provider, true)}
                />
              ))}
            </ul>
          </section>
        )
      })}
      {opened && (
        <ProviderDialog
          key={opened.provider}
          provider={opened}
          confirmDisconnect={disconnecting}
          inUse={
            isMultiCategory(opened.category)
              ? isConfigured(opened)
              : active[opened.category].provider === opened.provider
          }
          chosen={active[opened.category].chosen}
          connected={connectionOf(opened, tests[opened.provider]) === 'connected'}
          canUse={
            !isMultiCategory(opened.category) &&
            (providers.filter(p => p.category === opened.category).length > 1 || opened.category === 'recording')
          }
          canStore={canStore}
          keyUsers={keyUsersOf(providers, opened.provider)}
          oauthReturn={opened.provider === 'openrouter' ? oauthReturn : null}
          onTested={result => record(opened.provider, result)}
          onUse={() => use(opened.category, opened.provider)}
          onStopUsing={() => use(opened.category, null)}
          reload={reload}
          notify={notify}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
