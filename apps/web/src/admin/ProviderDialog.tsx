// Connect or manage one provider: its keys as a form. Save stores what changed (provider.setKeys) and
// then tests the connection (provider.test), so the dialog ends with "Connected" or a short reason.
// A stored secret never comes back from the API: secret inputs start empty and show "•••• 1234".
import {
  type ProviderPreset,
  type ProviderTestData,
  providerCategories,
  providers as providerSpecs,
  restartCategories,
} from '@linedesk/actions'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Switch } from '../ui/controls.tsx'
import { Dialog, FormField, Input, SecretInput } from '../ui/form.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { type ProviderField, type ProviderStatus, runAdmin, testProvider } from './api.ts'
import {
  changedValues,
  fieldErrors,
  initialValues,
  isConfigured,
  isOptional,
  isSwitch,
  providerState,
} from './model.ts'
import { errorText } from './notify.ts'
import { exchangeCode, type OpenRouterReturn, startOpenRouterConnect } from './openrouterAuth.ts'
import { Logo, presetMeta, providerMeta, redirectUris } from './ProviderLogo.tsx'
import { brandName } from '../brand.ts'

export const SERVER_SETTING_TIP = 'Set on the server. A value saved here takes priority.'

/** A value that comes from the server's settings: a small server icon, the rest in its tooltip. */
export function ServerSet() {
  return (
    <span className="adm-server" role="img" aria-label={SERVER_SETTING_TIP} title={SERVER_SETTING_TIP}>
      <Icon name="server" size={12} />
    </span>
  )
}

type Props = {
  provider: ProviderStatus
  inUse: boolean
  /** An admin picked this provider (not the default). */
  chosen: boolean
  /** "Use" makes sense: there is a choice, or recording is off without one. */
  canUse: boolean
  /** Open on the "Delete the stored keys?" step (Disconnect in the provider list). */
  confirmDisconnect?: boolean
  /** The page's last test of these keys worked. */
  connected: boolean
  canStore: boolean
  /** Providers that use this one's stored key (one-key mode): Disconnect removes it for them too. */
  keyUsers?: readonly ProviderStatus[]
  /** Back from "Connect with OpenRouter": the code to exchange, or why there is none. */
  oauthReturn?: OpenRouterReturn | null
  onTested: (result: ProviderTestData) => void
  onUse: () => Promise<void>
  /** Clears the pick of this category (recording: stop recording). */
  onStopUsing: () => Promise<void>
  reload: () => Promise<void>
  notify: (text: string) => void
  onClose: () => void
}

type Phase = 'idle' | 'saving' | 'testing' | 'confirm-disconnect' | 'disconnecting'

const helpOf = (provider: ProviderStatus) => (providerSpecs[provider.provider] as { help?: string }).help ?? null

const presetsOf = (provider: ProviderStatus) =>
  ((providerSpecs[provider.provider] as { presets?: readonly ProviderPreset[] }).presets ?? []) as ProviderPreset[]

export function ProviderDialog(props: Props) {
  const { provider, inUse, chosen, canUse, connected, canStore, oauthReturn, confirmDisconnect } = props
  const { onTested, onUse, onStopUsing, reload, notify, onClose, keyUsers = [] } = props
  const meta = providerMeta[provider.provider]
  const [values, setValues] = useState(() => initialValues(provider))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>(confirmDisconnect ? 'confirm-disconnect' : 'idle')
  const [result, setResult] = useState<ProviderTestData | null>(null)
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  /** Keys were stored in this dialog: sign-in and email apply after the API restarts. */
  const [savedNow, setSavedNow] = useState(false)
  const configured = isConfigured(provider)
  // OpenRouter connects through its own sign-in; typing a key is the fallback.
  const oauth = provider.provider === 'openrouter'
  const [manual, setManual] = useState(!oauth || configured)
  const changes = changedValues(provider, values)
  const dirty = Object.keys(changes).length > 0
  const busy = phase === 'saving' || phase === 'testing' || phase === 'disconnecting'
  const presets = presetsOf(provider)

  const set = (field: string, value: string) => {
    setValues(v => ({ ...v, [field]: value }))
    setErrors(({ [field]: _, ...rest }) => rest)
    setResult(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !manual) return
    const problems = fieldErrors(provider, values)
    setErrors(problems)
    const first = Object.keys(problems)[0]
    if (first) return document.getElementById(fieldId(first))?.focus()
    setResult(null)
    try {
      if (dirty) {
        setPhase('saving')
        await runAdmin('provider.setKeys', { provider: provider.provider, values: changes })
        setSavedNow(true)
        // Stored: secrets show as "•••• 1234" again instead of staying typed.
        setValues(v => ({ ...v, ...Object.fromEntries(provider.fields.filter(f => f.secret).map(f => [f.field, ''])) }))
      }
      setPhase('testing')
      const tested = await testProvider(provider.provider).catch(err => ({ ok: false, message: errorText(err) }))
      setResult(tested)
      onTested(tested)
      if (dirty) await reload()
      // Recording storage that works and nothing records yet: connecting it means "record there".
      if (tested.ok && provider.category === 'recording' && !inUse && !chosen) await onUse()
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    } finally {
      setPhase('idle')
    }
  }

  /** Stores the key OpenRouter handed out, then tests it like a typed one. */
  const finishing = useRef(false)
  useEffect(() => {
    if (!oauthReturn || finishing.current) return
    finishing.current = true
    if ('error' in oauthReturn) return setResult({ ok: false, message: oauthReturn.error })
    void (async () => {
      setPhase('saving')
      try {
        const key = await exchangeCode(oauthReturn.code, oauthReturn.verifier)
        await runAdmin('provider.setKeys', { provider: provider.provider, values: { api_key: key } })
        void reload() // shows as connected now, not only after the test
        setPhase('testing')
        const tested = await testProvider(provider.provider).catch(err => ({ ok: false, message: errorText(err) }))
        setResult(tested)
        onTested(tested)
        await reload()
      } catch (err) {
        setResult({ ok: false, message: errorText(err) })
      } finally {
        setPhase('idle')
      }
    })()
  }, [oauthReturn, provider.provider, onTested, reload])

  async function disconnect() {
    setPhase('disconnecting')
    try {
      await runAdmin('provider.clearKeys', { provider: provider.provider })
      if (inUse && chosen) await onStopUsing()
      await reload()
      notify(
        keyUsers.length
          ? `${[provider, ...keyUsers].map(p => p.label).join(', ')} disconnected.`
          : `${provider.label} disconnected.`,
      )
      onClose()
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
      setPhase('idle')
    }
  }

  const fieldId = (field: string) => `prov-${provider.provider}-${field}`
  const useLabel = provider.category === 'recording' ? 'Record here' : 'Use for calls'
  const keysUrl = preset ? presetMeta[preset.label]?.keysUrl : meta.keysUrl
  /** "Get a key" goes next to the first field the provider's key page hands out. */
  const keyField = provider.fields.find(f => f.secret || f.field === 'access_key_id' || f.field === 'account_sid')
  const working = result?.ok && !dirty
  const appliesOnRestart = restartCategories.includes(provider.category)
  const redirects = redirectUris(provider.provider, window.location.origin)
  const primaryLabel =
    phase === 'saving'
      ? 'Saving…'
      : phase === 'testing'
        ? 'Testing…'
        : configured && !dirty
          ? 'Test connection'
          : configured
            ? 'Save'
            : 'Connect'

  const footer =
    phase === 'confirm-disconnect' || phase === 'disconnecting' ? (
      <>
        <span className="k-dialog-foot-start adm-confirm-text">
          Delete the stored {provider.label} keys?
          {keyUsers.length > 0 &&
            ` ${keyUsers.map(p => p.label).join(' and ')} use${keyUsers.length === 1 ? 's' : ''} the same key and stop too.`}
        </span>
        <Button variant="ghost" onClick={() => setPhase('idle')} disabled={phase === 'disconnecting'}>
          Cancel
        </Button>
        <Button busy={phase === 'disconnecting'} type="button" variant="danger" onClick={() => void disconnect()} disabled={phase === 'disconnecting'}>
          {phase === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </>
    ) : (
      <>
        {providerState(provider) === 'app' && (
          <Button
            variant="ghost"
            className="k-dialog-foot-start adm-disconnect"
            disabled={busy || !canStore}
            onClick={() => setPhase('confirm-disconnect')}
          >
            Disconnect
          </Button>
        )}
        {provider.category === 'recording' && inUse && chosen && provider.fields.length === 0 && (
          <Button
            variant="ghost"
            className="k-dialog-foot-start"
            disabled={busy}
            onClick={() => void onStopUsing().then(onClose)}
          >
            Stop recording
          </Button>
        )}
        {canUse && !inUse && (connected || result?.ok) && !dirty && (
          <Button variant="secondary" className="k-dialog-foot-start" disabled={busy} onClick={() => void onUse()}>
            {useLabel}
          </Button>
        )}
        {working ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {manual && (
              <Button busy={phase === 'saving' || phase === 'testing'}
                type="submit"
                variant="primary"
                disabled={busy || (dirty && !canStore)}
                title={dirty ? 'Save and test (⌘S)' : undefined}
              >
                {primaryLabel}
              </Button>
            )}
          </>
        )}
      </>
    )

  return (
    <Dialog
      title={provider.label}
      description={`${providerCategories[provider.category]} · ${meta.blurb}`}
      icon={<Logo mark={meta.mark} size={40} />}
      onClose={busy ? () => {} : onClose}
      onSubmit={save}
      footer={footer}
    >
      {!canStore && provider.fields.length > 0 && (
        <p className="k-note">No encryption key on the server, so keys can't be saved.</p>
      )}
      {helpOf(provider) && provider.category !== 'recording' && <p className="k-field-desc">{helpOf(provider)}</p>}
      {presets.length > 0 && (
        <FormField label="Service" description={preset?.help}>
          <div className="adm-presets" role="radiogroup" aria-label="Service">
            {presets.map(p => (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={preset === p}
                className="adm-preset"
                disabled={!canStore}
                onClick={() => {
                  setPreset(p)
                  for (const [field, value] of Object.entries(p.values)) set(field, value)
                }}
              >
                {presetMeta[p.label] && <Logo mark={presetMeta[p.label]!.mark} size={28} />}
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </FormField>
      )}
      {provider.fields.length === 0 && <p className="k-field-desc">Nothing to set up.</p>}
      {!manual && !result?.ok && (
        <div className="adm-oauth">
          <Button busy={busy}
            variant="primary"
            disabled={busy || !canStore}
            onClick={() => void startOpenRouterConnect()}
            title={`Sign in to OpenRouter and create a key for ${brandName()}`}
          >
            {busy ? 'Connecting…' : 'Connect with OpenRouter'}
          </Button>
          <button type="button" className="k-link" onClick={() => setManual(true)}>
            Enter a key instead
          </button>
        </div>
      )}
      {manual &&
        provider.fields.map((field, i) => (
          <ProviderInput
            key={`${field.field}:${field.last4 ?? ''}`}
            id={fieldId(field.field)}
            provider={provider}
            field={field}
            value={values[field.field] ?? ''}
            error={errors[field.field]}
            disabled={!canStore || busy}
            autoFocus={i === 0 && !configured}
            keysUrl={field === keyField ? keysUrl : undefined}
            keysLabel={provider.category === 'sign_in' ? 'Create an app' : undefined}
            onChange={value => set(field.field, value)}
          />
        ))}
      {manual && redirects.length > 0 && <RedirectUris uris={redirects} />}
      {result && (
        <div className={result.ok ? 'k-note' : 'k-note k-note-danger'} role="status">
          <Icon name={!result.ok ? 'ban' : result.status === 'warning' ? 'alert' : 'check'} size={14} />
          <span className="adm-result">
            {result.ok
              ? appliesOnRestart && savedNow
                ? `Connected. ${brandName()} restarts in the background to apply it (a few seconds).`
                : resultLine(result.message)
              : result.message}
          </span>
        </div>
      )}
    </Dialog>
  )
}

/** A passing test's line: what it found ("Connected, balance 42.00 USD", a warning), ending with a full stop. */
const resultLine = (message: string) => (/[.!?]$/.test(message) ? message : `${message}.`)

type InputProps = {
  id: string
  provider: ProviderStatus
  field: ProviderField
  value: string
  error?: string
  disabled: boolean
  autoFocus: boolean
  /** Where the provider hands out this key: a "Get a key" link next to the label. */
  keysUrl?: string
  keysLabel?: string
  onChange: (value: string) => void
}

function ProviderInput(props: InputProps) {
  const { id, provider, field, value, error, disabled, autoFocus, keysUrl, keysLabel = 'Get a key', onChange } = props
  const fromServer = field.source === 'env' && <ServerSet />
  const getKey = keysUrl && (
    <a className="k-link adm-getkey" href={keysUrl} target="_blank" rel="noreferrer" title="Opens in a new tab">
      {keysLabel}
    </a>
  )
  const shared = field.key_from && (
    <span
      className="help"
      title="One-key mode: Disconnect there ends it here too; a key saved here is this provider's own"
    >
      Uses the {providerSpecs[field.key_from].label} key
    </span>
  )
  const aside = fromServer || shared || getKey || (isOptional(provider, field) ? 'Optional' : undefined)
  if (isSwitch(provider, field)) {
    const on = (value || field.value || 'true') !== 'false'
    return (
      <div className="adm-switch-field">
        <label htmlFor={id}>{field.label}</label>
        {fromServer}
        <Switch on={on} label={field.label} disabled={disabled} onChange={next => onChange(String(next))} />
      </div>
    )
  }
  return (
    <FormField id={id} label={field.label} aside={aside} error={error}>
      {field.secret ? (
        <SecretInput
          id={id}
          value={value}
          onChange={onChange}
          storedLast4={field.source === 'app' ? (field.last4 ?? '••••') : null}
          placeholder={field.source === 'env' ? 'Set on the server' : undefined}
          autoFocus={autoFocus}
          invalid={!!error}
        />
      ) : (
        <Input
          id={id}
          value={value}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          invalid={!!error}
          placeholder={field.hint ?? undefined}
          onChange={e => onChange(e.target.value)}
        />
      )}
    </FormField>
  )
}

/** The addresses to add to the provider's OAuth app, each with a copy button. */
function RedirectUris({ uris }: { uris: string[] }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (uri: string) =>
    navigator.clipboard.writeText(uri).then(
      () => setCopied(uri),
      () => setCopied(null),
    )
  return (
    <FormField label="Redirect URIs" description="Add these to the app's allowed redirect URIs.">
      <ul className="adm-redirects">
        {uris.map(uri => (
          <li key={uri}>
            <code>{uri}</code>
            <Button variant="ghost" size="sm" onClick={() => void copy(uri)} title="Copy" aria-label={`Copy ${uri}`}>
              <Icon name={copied === uri ? 'check' : 'copy'} size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </FormField>
  )
}
