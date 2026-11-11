// Admin, Providers: the connections of the install, one card per category. Each provider is a row
// with its logo, one line and its status; Connect or Manage opens its form (ProviderDialog). Every
// provider that is set up is tested when the page opens, so the badges say what works right now.
import {
  categoryNames,
  type ProviderCategory,
  providerCategories,
  type ProviderName,
  type ProviderTestData,
} from '@callfront/actions'
import { useEffect, useRef, useState } from 'react'
import { Card, HelpTip } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { type ActiveProviders, type ProviderStatus, runAdmin, testProvider } from './api.ts'
import { type Connection, connectionOf, isConfigured, providerState, type TestState } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { ProviderDialog, SERVER_SETTING_TIP } from './ProviderDialog.tsx'
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

function StatusBadge({ connection, test }: { connection: Connection; test: TestState }) {
  if (connection === 'none') return <Badge tone="outline">Not connected</Badge>
  if (connection === 'checking') return <Badge>Checking…</Badge>
  if (connection === 'connected')
    return (
      <Badge tone="ok" dot>
        Connected
      </Badge>
    )
  return (
    <Badge tone="danger" dot title={typeof test === 'object' ? test.message : undefined}>
      Error
    </Badge>
  )
}

type RowProps = {
  provider: ProviderStatus
  test: TestState
  inUse: boolean
  canUse: boolean
  onOpen: () => void
  onUse: () => void
}

function ProviderRow({ provider, test, inUse, canUse, onOpen, onUse }: RowProps) {
  const meta = providerMeta[provider.provider]
  const connection = connectionOf(provider, test)
  const configured = connection !== 'none'
  return (
    <li className="adm-conn">
      <Logo mark={meta.mark} />
      <div className="adm-conn-text">
        <div className="adm-conn-name">
          <b>{provider.label}</b>
          <StatusBadge connection={connection} test={test} />
          {inUse && <Badge>In use</Badge>}
          {configured && providerState(provider) === 'env' && (
            <Badge tone="outline" title={SERVER_SETTING_TIP}>
              From server settings
            </Badge>
          )}
        </div>
        {connection === 'error' && typeof test === 'object' && <span className="adm-conn-blurb">{test.message}</span>}
      </div>
      <div className="adm-conn-actions">
        {canUse && !inUse && connection === 'connected' && (
          <Button size="sm" variant="ghost" onClick={onUse} title={`Use ${provider.label}`}>
            Use
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={onOpen}
          title={configured ? `Manage ${provider.label}` : `Connect ${provider.label}`}
        >
          {configured ? 'Manage' : 'Connect'}
        </Button>
      </div>
    </li>
  )
}

export function Providers({ providers, active, canStore, notify, reload }: Props) {
  const { tests, record } = useConnectionTests(providers)
  const [open, setOpen] = useState<ProviderName | null>(null)
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
          Keys can't be saved yet: the server has no encryption key.{' '}
          <HelpTip text="Set SECRETS_KEY in the API's environment (generate one with: openssl rand -base64 32) and restart the API." />
        </p>
      )}
      {categoryNames.map(category => {
        const inCategory = providers.filter(p => p.category === category)
        const { provider: inUse } = active[category]
        // Recording has no fallback: without a pick, calls are not recorded.
        const canUse = inCategory.length > 1 || category === 'recording'
        // The title says what the category is; the one line left is recording being off.
        const description = category === 'recording' && !inUse ? 'Off: calls are not recorded.' : undefined
        return (
          <Card key={category} title={providerCategories[category]} description={description} className="adm-cat">
            <ul className="adm-conns">
              {inCategory.map(p => (
                <ProviderRow
                  key={p.provider}
                  provider={p}
                  test={tests[p.provider]}
                  inUse={inUse === p.provider}
                  canUse={canUse}
                  onOpen={() => setOpen(p.provider)}
                  onUse={() => void use(category, p.provider)}
                />
              ))}
            </ul>
          </Card>
        )
      })}
      {opened && (
        <ProviderDialog
          key={opened.provider}
          provider={opened}
          inUse={active[opened.category].provider === opened.provider}
          chosen={active[opened.category].chosen}
          canUse={providers.filter(p => p.category === opened.category).length > 1 || opened.category === 'recording'}
          canStore={canStore}
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
