// Admin, Providers: the connections of the install. A light heading per category, its providers as
// compact tiles (logo, name, one status). A tile opens the provider's dialog (ProviderDialog), where
// it is connected, tested and chosen. Every provider that is set up is tested when the page opens,
// so the status says what works right now.
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
import { cx } from '../ui/kit.tsx'
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

type TileProps = { provider: ProviderStatus; test: TestState; inUse: boolean; onOpen: () => void }

function ProviderTile({ provider, test, inUse, onOpen }: TileProps) {
  const status = tileStatus(provider, test, inUse)
  const fromServer = isConfigured(provider) && providerState(provider) === 'env'
  return (
    <li>
      <button
        type="button"
        className={cx('adm-tile', status.dot === 'ink' && 'adm-tile-active')}
        onClick={onOpen}
        title={`${status.dot === null && status.word === 'Not connected' ? 'Connect' : 'Manage'} ${provider.label}`}
      >
        <Logo mark={providerMeta[provider.provider].mark} />
        <span className="adm-tile-text">
          <b>{provider.label}</b>
          <span className={cx('adm-tile-status', status.dot && `adm-dot-${status.dot}`)} title={status.title}>
            {status.word}
            {fromServer && <ServerSet />}
          </span>
        </span>
      </button>
    </li>
  )
}

export function Providers({ providers, active, canStore, notify, reload }: Props) {
  const { tests, record } = useConnectionTests(providers)
  // Back from "Connect with OpenRouter": its dialog opens and finishes the connection.
  const [oauthReturn] = useState<OpenRouterReturn | null>(() => peekOpenRouterReturn())
  useEffect(clearOpenRouterReturn, [])
  const [open, setOpen] = useState<ProviderName | null>(oauthReturn ? 'openrouter' : null)
  const opened = providers.find(p => p.provider === open)

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
      {categoryNames.map(category => {
        const inCategory = providers.filter(p => p.category === category)
        const { provider: inUse } = active[category]
        // A realtime model answers calls: the three stages are not used for them.
        const replaced = !!active.realtime?.provider && (category === 'stt' || category === 'llm' || category === 'tts')
        return (
          <section key={category} className="adm-provcat" aria-labelledby={`adm-cat-${category}`}>
            <h2 id={`adm-cat-${category}`}>
              {providerCategories[category]}
              {category === 'recording' && !inUse && <span className="adm-provcat-note">Off</span>}
              {replaced && <span className="adm-provcat-note">Not used: the realtime model answers calls</span>}
            </h2>
            <ul className="adm-tiles">
              {inCategory.map(p => (
                <ProviderTile
                  key={p.provider}
                  provider={p}
                  test={tests[p.provider]}
                  inUse={isMultiCategory(category) ? isConfigured(p) : inUse === p.provider}
                  onOpen={() => setOpen(p.provider)}
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
