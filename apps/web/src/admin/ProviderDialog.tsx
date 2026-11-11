// Connect or manage one provider: its keys as a form. Save stores what changed (provider.setKeys) and
// then tests the connection (provider.test), so the dialog ends with "Connected" or a short reason.
// A stored secret never comes back from the API: secret inputs start empty and show "•••• 1234".
import {
  type ProviderPreset,
  type ProviderTestData,
  providerCategories,
  providers as providerSpecs,
} from '@callfront/actions'
import { type FormEvent, useState } from 'react'
import { Switch } from '../ui/controls.tsx'
import { Dialog, FormField, Input, SecretInput } from '../ui/form.tsx'
import { Badge, Button, Icon } from '../ui/kit.tsx'
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
import { Logo, presetMarks, providerMeta } from './ProviderLogo.tsx'

export const SERVER_SETTING_TIP = 'Set on the server. A value saved here takes priority.'

type Props = {
  provider: ProviderStatus
  inUse: boolean
  /** An admin picked this provider (not the default). */
  chosen: boolean
  /** "Use this provider" makes sense: there is a choice, or recording is off without one. */
  canUse: boolean
  canStore: boolean
  onTested: (result: ProviderTestData) => void
  onUse: () => Promise<void>
  /** Clears the pick of this category (recording: stop recording). */
  onStopUsing: () => Promise<void>
  reload: () => Promise<void>
  notify: (text: string) => void
  onClose: () => void
}

type Phase = 'idle' | 'saving' | 'testing' | 'confirm-disconnect' | 'disconnecting'

const presetsOf = (provider: ProviderStatus) =>
  ((providerSpecs[provider.provider] as { presets?: readonly ProviderPreset[] }).presets ?? []) as ProviderPreset[]

export function ProviderDialog(props: Props) {
  const { provider, inUse, chosen, canUse, canStore, onTested, onUse, onStopUsing, reload, notify, onClose } = props
  const meta = providerMeta[provider.provider]
  const [values, setValues] = useState(() => initialValues(provider))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<ProviderTestData | null>(null)
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const configured = isConfigured(provider)
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
    if (busy) return
    const problems = fieldErrors(provider, values)
    setErrors(problems)
    const first = Object.keys(problems)[0]
    if (first) return document.getElementById(fieldId(first))?.focus()
    setResult(null)
    try {
      if (dirty) {
        setPhase('saving')
        await runAdmin('provider.setKeys', { provider: provider.provider, values: changes })
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

  async function disconnect() {
    setPhase('disconnecting')
    try {
      await runAdmin('provider.clearKeys', { provider: provider.provider })
      if (inUse && chosen) await onStopUsing()
      await reload()
      notify(`${provider.label} disconnected.`)
      onClose()
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
      setPhase('idle')
    }
  }

  const fieldId = (field: string) => `prov-${provider.provider}-${field}`
  const working = result?.ok && !dirty
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
        <span className="k-dialog-foot-start adm-confirm-text">Delete the stored {provider.label} keys?</span>
        <Button variant="ghost" onClick={() => setPhase('idle')} disabled={phase === 'disconnecting'}>
          Cancel
        </Button>
        <Button type="button" variant="danger" onClick={() => void disconnect()} disabled={phase === 'disconnecting'}>
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
        {working ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || (dirty && !canStore)}
              title={dirty ? 'Save and test (⌘S)' : undefined}
            >
              {primaryLabel}
            </Button>
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
        <p className="k-note">Keys can't be saved yet: the server has no encryption key.</p>
      )}
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
                {presetMarks[p.label] && <Logo mark={presetMarks[p.label]!} size={28} />}
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </FormField>
      )}
      {provider.fields.length === 0 && <p className="k-field-desc">Nothing to set up.</p>}
      {provider.fields.map((field, i) => (
        <ProviderInput
          key={`${field.field}:${field.last4 ?? ''}`}
          id={fieldId(field.field)}
          provider={provider}
          field={field}
          value={values[field.field] ?? ''}
          error={errors[field.field]}
          disabled={!canStore || busy}
          autoFocus={i === 0 && !configured}
          onChange={value => set(field.field, value)}
        />
      ))}
      {result && (
        <div className={result.ok ? 'k-note' : 'k-note k-note-danger'} role="status">
          <Icon name={result.ok ? 'check' : 'ban'} size={14} />
          <span className="adm-result">
            {result.ok ? 'Connected.' : result.message}
            {result.ok && canUse && !inUse && (
              <Button size="sm" variant="secondary" onClick={() => void onUse()}>
                Use this provider
              </Button>
            )}
          </span>
        </div>
      )}
    </Dialog>
  )
}

type InputProps = {
  id: string
  provider: ProviderStatus
  field: ProviderField
  value: string
  error?: string
  disabled: boolean
  autoFocus: boolean
  onChange: (value: string) => void
}

function ProviderInput({ id, provider, field, value, error, disabled, autoFocus, onChange }: InputProps) {
  const fromServer = field.source === 'env' && (
    <Badge tone="outline" title={SERVER_SETTING_TIP}>
      From server settings
    </Badge>
  )
  const aside = fromServer || (isOptional(provider, field) ? 'Optional' : undefined)
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
