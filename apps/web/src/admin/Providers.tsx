// Admin, Providers: the connections of the install. A light heading per category, its providers as
// one compact list (logo, name and one status on the left; Connect, or Edit and Disconnect on the right).
// Connect and Edit open the provider's dialog (ProviderDialog), where it is connected, tested and chosen.
// Sign-in and calendar share their OAuth apps: Google and Microsoft are listed under both, with one
// connection. Every provider that is set up is tested when the page opens, so the status says what works now.
import {
  categoryNames,
  isMultiCategory,
  type ProviderCategory,
  providerCategories,
  type ProviderName,
  type ProviderTestData,
} from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { HelpTip } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { type ActiveProviders, type ProviderStatus, runAdmin, testProvider } from './api.ts'
import { connectionOf, isConfigured, providerState, type TestState } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { clearOpenRouterReturn, type OpenRouterReturn, peekOpenRouterReturn } from './openrouterAuth.ts'
import { ProviderDialog, ServerSet } from './ProviderDialog.tsx'
import { Logo, providerMeta } from './ProviderLogo.tsx'

type Props = {
  providers: ProviderStatus[]
  active: ActiveProviders
  canStore: boolean
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

type TileStatus = { word: string; dot: 'ink' | 'muted' | 'danger' | null; title?: string }

/** One status per tile: Active, Connected, Error, Checking… or Not connected. */
export function tileStatus(provider: ProviderStatus, test: TestState, inUse: boolean): TileStatus {
  const connection = connectionOf(provider, test)
  if (connection === 'none') return { word: 'Not connected', dot: null }
  if (connection === 'checking') return { word: 'Checking…', dot: null }
  if (connection === 'error')
    return { word: 'Error', dot: 'danger', title: typeof test === 'object' ? test.message : undefined }
  return inUse ? { word: 'Active', dot: 'ink' } : { word: 'Connected', dot: 'muted' }
}

type RowProps = {
  provider: ProviderStatus
  test: TestState
  inUse: boolean
  canStore: boolean
  onOpen: () => void
  onDisconnect: () => void
}

/** One provider: logo, name and status; Connect when it has no keys, else Edit (and Disconnect for keys stored here). */
function ProviderRow({ provider, test, inUse, canStore, onOpen, onDisconnect }: RowProps) {
  const status = tileStatus(provider, test, inUse)
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
      </span>
      <span className="adm-prov-actions">
        {configured ? (
          <>
            {providerState(provider) === 'app' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canStore}
                onClick={onDisconnect}
                title={`Disconnect ${provider.label}`}
              >
                Disconnect
              </Button>
            )}
            <Button size="sm" onClick={onOpen} title={`Edit ${provider.label}`}>
              Edit
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

export function Providers({ providers, active, canStore, notify, reload }: Props) {
  const { tests, record } = useConnectionTests(providers)
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
        <p className="adm-notice" role="note">
          No encryption key on the server, so keys can't be saved.{' '}
          <HelpTip text="Whoever runs the server sets SECRETS_KEY (make one with openssl rand -base64 32) and restarts the API. Keys are then saved encrypted." />
        </p>
      )}
      {pageSections.map(({ id, title, category, only }) => {
        const inSection = providers.filter(p => p.category === category && (!only || only.includes(p.provider)))
        const { provider: inUse } = active[category]
        // A realtime model answers calls: the three stages are not used for them.
        const replaced = !!active.realtime?.provider && (category === 'stt' || category === 'llm' || category === 'tts')
        return (
          <section key={id} className="adm-provcat" aria-labelledby={`adm-cat-${id}`}>
            <h2 id={`adm-cat-${id}`}>
              {title}
              {category === 'recording' && !inUse && <span className="adm-provcat-note">Off</span>}
              {replaced && <span className="adm-provcat-note">Not used: the realtime model answers calls</span>}
              {only && <span className="adm-provcat-note">The same apps as for sign-in: connected once for both</span>}
            </h2>
            <ul className="adm-provlist">
              {inSection.map(p => (
                <ProviderRow
                  key={p.provider}
                  provider={p}
                  test={tests[p.provider]}
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
