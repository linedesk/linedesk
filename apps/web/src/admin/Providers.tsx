// Provider keys. A stored secret never comes back from the API, so the inputs start empty
// every time and the page only shows the last four characters.
import {
  categoryEnv,
  categoryNames,
  providerCategories,
  providers as providerSpecs,
  type ProviderCategory,
  type ProviderName,
  type ProviderTestData,
} from '@callfront/actions'
import { useState, type FormEvent } from 'react'
import { Badge, Button } from '../ui/kit.tsx'
import { type ActiveProviders, type ProviderField, type ProviderStatus, runAdmin, testProvider } from './api.ts'
import { fieldValueText, providerState, stateLabel } from './model.ts'
import { Confirm, when } from './parts.tsx'
import { errorText, type Notify } from './notify.ts'

const envName = (provider: ProviderStatus, field: ProviderField) =>
  (providerSpecs[provider.provider].fields as Record<string, { env: string }>)[field.field]?.env ?? ''

function fieldNote(provider: ProviderStatus, field: ProviderField): string {
  if (field.source === 'env') return `from ${envName(provider, field)}`
  if (field.source !== 'app') return ''
  return `changed ${when(field.updated_at)}${field.updated_by ? ` by ${field.updated_by.name}` : ''}`
}

type FormProps = { provider: ProviderStatus; onSaved: () => Promise<void>; onCancel: () => void }

function KeysForm({ provider, onSaved, onCancel }: FormProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !Object.keys(filled).length) return
    setBusy(true)
    setError(null)
    try {
      await runAdmin('provider.setKeys', { provider: provider.provider, values: filled })
      await onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <form className="adm-keys" onSubmit={save} onKeyDown={e => e.key === 'Escape' && onCancel()}>
      {provider.fields.map((field, i) => {
        const id = `adm-${provider.provider}-${field.field}`
        return (
          <div key={field.field} className="field">
            <label htmlFor={id}>{field.label}</label>
            <span className="k-input">
              <input
                id={id}
                // Not type=password: browsers offer to save a password field as a login, and the key
                // would end up in the password manager. Masked by CSS instead.
                type="text"
                className={field.secret ? 'adm-secret' : undefined}
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                spellCheck={false}
                autoFocus={i === 0}
                value={values[field.field] ?? ''}
                placeholder={field.source === 'app' ? 'Leave empty to keep the stored value' : ''}
                onChange={e => setValues(current => ({ ...current, [field.field]: e.target.value }))}
              />
            </span>
          </div>
        )
      })}
      <div className="adm-keys-foot">
        <span className="help">Stored encrypted. Keys are not shown again after saving.</span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy || !Object.keys(filled).length}>
          Save keys
        </Button>
      </div>
      {error && (
        <span className="adm-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}

type RowProps = {
  provider: ProviderStatus
  /** The category uses this provider. */
  inUse: boolean
  canStore: boolean
  toast: (text: string) => void
  reload: () => Promise<void>
}

function ProviderRow({ provider, inUse, canStore, toast, reload }: RowProps) {
  const [mode, setMode] = useState<'idle' | 'edit' | 'clear'>('idle')
  const [test, setTest] = useState<ProviderTestData | 'running' | null>(null)
  const state = providerState(provider)

  async function runTest() {
    setTest('running')
    setTest(await testProvider(provider.provider).catch(err => ({ ok: false, message: errorText(err) })))
  }
  async function saved() {
    setMode('idle')
    setTest(null)
    await reload()
    toast(`${provider.label} keys saved.`)
  }
  async function clear() {
    await runAdmin('provider.clearKeys', { provider: provider.provider })
    setMode('idle')
    setTest(null)
    await reload()
    toast(`${provider.label} keys cleared.`)
  }

  return (
    <div className="adm-prov">
      <div className="adm-prov-head">
        <b>{provider.label}</b>
        <Badge>{stateLabel[state]}</Badge>
        {inUse && <Badge>In use</Badge>}
        <span className="adm-prov-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={state === 'none' || test === 'running'}
            onClick={() => void runTest()}
          >
            Test connection
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canStore}
            aria-expanded={mode === 'edit'}
            onClick={() => setMode('edit')}
          >
            Edit
          </Button>
          {state === 'app' && (
            <Button size="sm" variant="ghost" aria-expanded={mode === 'clear'} onClick={() => setMode('clear')}>
              Clear
            </Button>
          )}
        </span>
      </div>
      <dl className="adm-prov-fields">
        {provider.fields.map(field => (
          <div key={field.field}>
            <dt>{field.label}</dt>
            <dd>
              <span className={field.secret || !field.source ? undefined : 'adm-mono'}>{fieldValueText(field)}</span>{' '}
              <span className="help">{fieldNote(provider, field)}</span>
            </dd>
          </div>
        ))}
      </dl>
      {test && (
        <p className="adm-test" role="status">
          {test === 'running' ? (
            'Testing…'
          ) : test.ok ? (
            <b>Connected</b>
          ) : (
            <>
              <b>Not connected.</b> {test.message}
            </>
          )}
        </p>
      )}
      {mode === 'edit' && <KeysForm provider={provider} onSaved={saved} onCancel={() => setMode('idle')} />}
      {mode === 'clear' && (
        <Confirm
          action="Clear keys"
          onConfirm={clear}
          onCancel={() => setMode('idle')}
          text={`The stored ${provider.label} keys are deleted. Values from the environment apply again, if there are any.`}
        />
      )}
    </div>
  )
}

type Props = {
  providers: ProviderStatus[]
  active: ActiveProviders
  canStore: boolean
  notify: Notify
  reload: () => Promise<void>
}

/** What a category uses without a pick, matching the API and the voice agent. */
const defaultNote = (category: ProviderCategory) =>
  category === 'telephony'
    ? 'Default: TELEPHONY_PROVIDER from the environment, else the first carrier that is set up (Telnyx before Twilio), else no carrier.'
    : `Default: ${categoryEnv[category]} from the environment, else the first provider that is set up.`

/** Says which provider a category uses, and warns when the picked one cannot work yet. */
function categoryNote(category: ProviderCategory, chosen: boolean, inUse: ProviderStatus | undefined): string {
  if (!chosen) return defaultNote(category)
  if (inUse && providerState(inUse) === 'none')
    return `Picked here, but ${inUse.label} has no keys yet: set them below, or pick Default.`
  return 'Picked here.'
}

export function Providers({ providers, active, canStore, notify, reload }: Props) {
  async function use(category: ProviderCategory, provider: ProviderName | null) {
    const before = active[category].chosen ? active[category].provider : null
    const set = async (next: ProviderName | null) => {
      await runAdmin('provider.setActive', { category, provider: next })
      await reload()
    }
    try {
      await set(provider)
      const label = provider ? providers.find(p => p.provider === provider)!.label : 'the default'
      notify(`${providerCategories[category]} uses ${label} now.`, () => set(before))
    } catch (err) {
      notify(errorText(err))
    }
  }
  return (
    <>
      {!canStore && (
        <p className="adm-notice" role="note">
          Keys cannot be stored yet: <code>SECRETS_KEY</code> is not set. Generate one with{' '}
          <code>openssl rand -base64 32</code>, set it in the environment of the API and restart.
        </p>
      )}
      {categoryNames.map(category => {
        const inCategory = providers.filter(p => p.category === category)
        const { provider: inUse, chosen } = active[category]
        return (
          <section key={category} className="adm-card adm-cat" aria-label={providerCategories[category]}>
            <div className="adm-cat-head">
              <div>
                <h2>{providerCategories[category]}</h2>
                <p className="help">
                  {categoryNote(
                    category,
                    chosen,
                    inCategory.find(p => p.provider === inUse),
                  )}
                </p>
              </div>
              {inCategory.length > 1 && (
                <div className="adm-seg" role="radiogroup" aria-label={`${providerCategories[category]} provider`}>
                  {[{ id: null, label: 'Default' }, ...inCategory.map(p => ({ id: p.provider, label: p.label }))].map(
                    option => {
                      const on = option.id === null ? !chosen : chosen && inUse === option.id
                      return (
                        <button
                          key={option.label}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          className="adm-seg-opt"
                          onClick={() => !on && void use(category, option.id)}
                        >
                          {option.label}
                        </button>
                      )
                    },
                  )}
                </div>
              )}
            </div>
            {inCategory.map(p => (
              <ProviderRow
                key={p.provider}
                provider={p}
                inUse={inUse === p.provider}
                canStore={canStore}
                toast={notify}
                reload={reload}
              />
            ))}
          </section>
        )
      })}
    </>
  )
}
