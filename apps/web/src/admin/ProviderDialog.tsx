// The one editor of a provider (LIN-158), wherever it opens (Server admin › Providers, the install walkthrough): its
// status with when it was tested, how to get a key (open until it works), the keys as a form (ProviderForm), Test again
// (the free key check) and Try it (a real round trip, TryOut.tsx). Save stores what changed (provider.setKeys) and then
// tests the keys: one loading state on the primary button meanwhile; when the keys work the dialog closes and a toast
// says so, when they do not it stays open with the error (LIN-364). A stored secret never comes back from the API:
// secret inputs start empty and show "•••• 1234".
import {
  type ProviderLine,
  type ProviderPreset,
  type ProviderTestData,
  providerCategoryLabel,
  providerSpec,
  providers as providerSpecs,
  restartCategories,
} from '@linedesk/actions'
import { useFormat, useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { brandName } from '../brand.ts'
import { Switch } from '../ui/controls.tsx'
import { Dialog, FormField, Input, SecretInput } from '../ui/form.tsx'
import { LinkButton } from '../ui/AppLink.tsx'
import { Button, Icon, Note } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type ProviderField, type ProviderStatus, runAdmin, testProvider } from './api.ts'
import {
  afterTest,
  changedValues,
  fieldErrors,
  initialValues,
  isConfigured,
  isOptional,
  isPhone,
  isSwitch,
  providerState,
  selectsOnConnect,
} from './model.ts'
import { errorText } from './notify.ts'
import { exchangeCode, type OpenRouterReturn, openRouterErrorText, startOpenRouterConnect } from './openrouterAuth.ts'
import { stepUpRefusalText } from './PasskeyStepUp.tsx'
import { ProviderError } from './ProviderError.tsx'
import { StatusWords } from './ProviderGroup.tsx'
import { Logo, presetMeta, providerMeta, redirectUris } from './ProviderLogo.tsx'
import { testedAgo } from './providerStatus.ts'
import { TryOut, tryKindOf } from './TryOut.tsx'
import { i18n } from '../i18n/index.tsx'

/** A value that comes from the server's settings: a small server icon, the rest in its tooltip. */
export function ServerSet() {
  const t = useT()
  const tip = t('admin.providerDialog.serverSetTip')
  return (
    <span className="adm-server" role="img" aria-label={tip} title={tip}>
      <Icon name="server" size={12} />
    </span>
  )
}

type Props = {
  provider: ProviderStatus
  /** Its status, as every screen shows it (providerStatus.ts). */
  line: ProviderLine
  inUse: boolean
  /** An admin picked this provider (not the default). */
  chosen: boolean
  /** "Use" makes sense: there is a choice, or recording is off without one. */
  canUse: boolean
  canStore: boolean
  /** Providers that use this one's stored key (one-key mode): Disconnect removes it for them too. */
  keyUsers?: readonly ProviderStatus[]
  /** Back from "Connect with OpenRouter": the code to exchange, or why there is none. */
  oauthReturn?: OpenRouterReturn | null
  /** `stored`: the keys were saved just before the test; the admin data is reloaded next. */
  onTested: (result: ProviderTestData, stored: boolean) => void
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
  const { provider, line, inUse, chosen, canUse, canStore, oauthReturn } = props
  const { onTested, onUse, onStopUsing, reload, notify, onClose, keyUsers = [] } = props
  const t = useT()
  const format = useFormat()
  const meta = providerMeta[provider.provider]
  const [values, setValues] = useState(() => initialValues(provider))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<ProviderTestData | null>(null)
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  /** Keys were stored in this dialog: sign-in applies after the API restarts. */
  const [savedNow, setSavedNow] = useState(false)
  /** The running save connects a provider that had no keys: the button says "Connecting…" until the dialog closes. */
  const [connecting, setConnecting] = useState(false)
  const configured = isConfigured(provider)
  const connected = configured && line.state === 'works'
  // OpenRouter connects through its own sign-in; typing a key is the fallback.
  const oauth = provider.provider === 'openrouter'
  const [manual, setManual] = useState(!oauth || configured)
  const changes = changedValues(provider, values)
  const dirty = Object.keys(changes).length > 0
  const busy = phase === 'saving' || phase === 'testing' || phase === 'disconnecting'

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
    setConnecting(!configured)
    try {
      if (dirty) {
        setPhase('saving')
        await runAdmin('provider.setKeys', { provider: provider.provider, values: changes })
        setSavedNow(true)
      }
      setPhase('testing')
      const tested = await testProvider(provider.provider, { free: true }).catch(err => ({
        ok: false,
        message: errorText(err),
      }))
      await finish(tested, dirty)
    } catch (err) {
      setResult({ ok: false, message: stepUpRefusalText(err) ?? errorText(err) })
      setPhase('idle')
    }
  }

  /**
   * After the test: the row shows the new state before anything else (CLAUDE.md rule 3), then a pass closes the dialog
   * with a toast; a failure or a warning stays open, the button loading until then and never next to a result.
   */
  async function finish(tested: ProviderTestData, stored: boolean) {
    onTested(tested, stored)
    if (stored) await reload()
    // Recording storage or after-call transcription that works and none is selected yet: connecting it means "use it".
    if (tested.ok && selectsOnConnect(provider.category) && !inUse && !chosen) await onUse()
    const next = afterTest(tested, {
      stored,
      wasConfigured: configured,
      restarts: restartCategories.includes(provider.category),
    })
    if (next.close) {
      const params = { provider: provider.label, brand: brandName() }
      notify(
        next.toast === 'connectedToastRestart'
          ? t('admin.providerDialog.connectedToastRestart', params)
          : next.toast === 'worksToast'
            ? t('admin.providerDialog.worksToast', params)
            : t('admin.providerDialog.connectedToast', params),
      )
      return onClose()
    }
    // Stored and still open: secrets show as "•••• 1234" again instead of staying typed.
    if (stored)
      setValues(v => ({ ...v, ...Object.fromEntries(provider.fields.filter(f => f.secret).map(f => [f.field, ''])) }))
    setResult(tested)
    setPhase('idle')
  }

  /** Stores the key OpenRouter handed out, then tests it like a typed one. */
  const finishing = useRef(false)
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(() => {
    if (!oauthReturn || finishing.current) return
    finishing.current = true
    if ('error' in oauthReturn) return setResult({ ok: false, message: openRouterErrorText(oauthReturn.error) })
    void (async () => {
      setConnecting(true)
      setPhase('saving')
      try {
        const key = await exchangeCode(oauthReturn.code, oauthReturn.verifier)
        await runAdmin('provider.setKeys', { provider: provider.provider, values: { api_key: key } })
        setSavedNow(true)
        setPhase('testing')
        const tested = await testProvider(provider.provider, { free: true }).catch(err => ({
          ok: false,
          message: errorText(err),
        }))
        await finishRef.current(tested, true)
      } catch (err) {
        setResult({ ok: false, message: stepUpRefusalText(err) ?? errorText(err) })
        setPhase('idle')
      }
    })()
  }, [oauthReturn, provider.provider])

  async function disconnect() {
    setPhase('disconnecting')
    try {
      await runAdmin('provider.clearKeys', { provider: provider.provider })
      if (inUse && chosen) await onStopUsing()
      await reload()
      notify(
        t('admin.providerDialog.disconnected', { providers: format.list([provider, ...keyUsers].map(p => p.label)) }),
      )
      onClose()
    } catch (err) {
      setResult({ ok: false, message: stepUpRefusalText(err) ?? errorText(err) })
      setPhase('idle')
    }
  }

  const fieldId = (field: string) => `prov-${provider.provider}-${field}`
  const tryKind = tryKindOf(provider.category)
  const useLabel =
    provider.category === 'recording'
      ? t('admin.providerDialog.recordHere')
      : provider.category === 'transcript'
        ? t('admin.providerDialog.useAfterCalls')
        : t('admin.providerDialog.useForCalls')
  const keysUrl = preset ? presetMeta[preset.label]?.keysUrl : meta.keysUrl
  /** "Get a key" goes next to the first field the provider's key page hands out. */
  const keyField = provider.fields.find(f => f.secret || f.field === 'access_key_id' || f.field === 'account_sid')
  const working = result?.ok && !dirty
  const appliesOnRestart = restartCategories.includes(provider.category)
  const redirects = redirectUris(provider.provider, window.location.origin)
  // One loading state, on the button: what the dialog is doing, the same from saving to the closing toast.
  const primaryLabel =
    phase === 'saving' || phase === 'testing'
      ? connecting
        ? t('admin.providerDialog.connecting')
        : dirty || savedNow
          ? t('common.action.saving')
          : t('admin.providerDialog.testing')
      : configured && !dirty
        ? t('admin.providerDialog.testAgain')
        : configured
          ? t('common.action.save')
          : t('admin.providers.connect')

  const footer =
    phase === 'confirm-disconnect' || phase === 'disconnecting' ? (
      <>
        <span className="k-dialog-foot-start adm-confirm-text">
          {t('admin.providerDialog.confirmDisconnect', { provider: provider.label })}
          {keyUsers.length > 0 &&
            ` ${t('admin.providerDialog.confirmSharedKey', {
              providers: format.list(keyUsers.map(p => p.label)),
              count: keyUsers.length,
            })}`}
        </span>
        <Button variant="ghost" onClick={() => setPhase('idle')} disabled={phase === 'disconnecting'}>
          {t('common.action.cancel')}
        </Button>
        <Button
          busy={phase === 'disconnecting'}
          type="button"
          variant="danger"
          onClick={() => void disconnect()}
          disabled={phase === 'disconnecting'}
        >
          {phase === 'disconnecting' ? t('admin.providerDialog.disconnecting') : t('admin.providerDialog.disconnect')}
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
            {t('admin.providerDialog.disconnect')}
          </Button>
        )}
        {provider.category === 'transcript' && inUse && chosen && (
          <Button
            variant="ghost"
            className="k-dialog-foot-start"
            disabled={busy}
            onClick={() => void onStopUsing().then(onClose)}
          >
            {t('admin.afterCallTranscript.stop')}
          </Button>
        )}
        {provider.category === 'recording' && inUse && chosen && provider.fields.length === 0 && (
          <Button
            variant="ghost"
            className="k-dialog-foot-start"
            disabled={busy}
            onClick={() => void onStopUsing().then(onClose)}
          >
            {t('admin.providerDialog.stopRecording')}
          </Button>
        )}
        {canUse && !inUse && (connected || result?.ok) && !dirty && (
          <Button variant="secondary" className="k-dialog-foot-start" disabled={busy} onClick={() => void onUse()}>
            {useLabel}
          </Button>
        )}
        {working ? (
          <Button variant="primary" onClick={onClose}>
            {t('admin.providerDialog.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('common.action.cancel')}
            </Button>
            {manual && (
              <Button
                busy={phase === 'saving' || phase === 'testing'}
                type="submit"
                variant="primary"
                disabled={busy || (dirty && !canStore)}
                title={
                  dirty
                    ? t('admin.providerDialog.saveTip', { key: '⌘S' })
                    : configured
                      ? t('admin.providerDialog.testAgainTip', { key: '⌘S' })
                      : undefined
                }
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
      description={t('admin.providerDialog.description', {
        category: providerCategoryLabel(provider.category, i18n()),
        blurb: t(meta.blurb),
      })}
      icon={<Logo mark={meta.mark} size={40} />}
      onClose={busy ? () => {} : onClose}
      onSubmit={save}
      footer={footer}
    >
      {!canStore && provider.fields.length > 0 && <Note tone="warning">{t('admin.providers.noSecretsKey')}</Note>}
      {configured && (
        <p className="adm-group-status" role="status">
          <StatusMark state={line.state} /> <StatusWords status={line} />
          {testedAgo(line.testedAt) ? ` · ${testedAgo(line.testedAt)}` : ''}
          {line.state === 'failing' && line.message && !result ? (
            <ProviderError message={line.message} at={line.failedAt} />
          ) : null}
        </p>
      )}
      {provider.fields.length > 0 && <KeyGuide provider={provider} open={!connected} />}
      <ProviderForm
        provider={provider}
        values={values}
        errors={errors}
        canStore={canStore}
        busy={busy}
        configured={configured}
        manual={manual}
        oauthDone={!!result?.ok}
        preset={preset}
        keysUrl={keysUrl}
        keyField={keyField?.field ?? null}
        redirects={redirects}
        fieldId={fieldId}
        onManual={() => setManual(true)}
        onPreset={p => {
          setPreset(p)
          for (const [field, value] of Object.entries(p.values)) set(field, value)
        }}
        onChange={set}
      />
      {result && !busy && (
        <Note tone={!result.ok ? 'danger' : result.status === 'warning' ? 'warning' : 'success'} role="status">
          <span className="adm-result">
            {result.ok ? (
              appliesOnRestart && savedNow ? (
                t('admin.providerDialog.connectedRestart', { brand: brandName() })
              ) : (
                resultLine(result.message)
              )
            ) : (
              <>
                <strong>{t('admin.providerDialog.failed', { provider: provider.label })}</strong>{' '}
                {resultLine(result.message)}
              </>
            )}
          </span>
        </Note>
      )}
      {tryKind && inUse && (connected || result?.ok) && !dirty && (
        <TryOut kind={tryKind} primary={false} onTried={reload} />
      )}
    </Dialog>
  )
}

/** How to get a key for this provider: the registry's steps, the page, what it costs. Open until it works. */
function KeyGuide({ provider, open }: { provider: ProviderStatus; open: boolean }) {
  const t = useT()
  const { guide, label } = providerSpec(provider.provider)
  return (
    <details className="adm-guide" open={open}>
      <summary>{t('admin.providerDialog.howToGetKey')}</summary>
      <ol className="adm-guide-steps">
        {guide.steps.map(step => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="help">
        {guide.url && (
          <>
            <a href={guide.url} target="_blank" rel="noreferrer" title={t('admin.providerDialog.opensNewTab')}>
              {t('admin.providerDialog.openProvider', { provider: label })}
            </a>
            {' · '}
          </>
        )}
        {guide.cost}
      </p>
    </details>
  )
}

type FormProps = {
  provider: ProviderStatus
  values: Record<string, string>
  errors: Record<string, string>
  canStore: boolean
  busy: boolean
  configured: boolean
  /** Typing keys (OpenRouter starts with its own sign-in instead). */
  manual: boolean
  /** OpenRouter's sign-in finished and the key works. */
  oauthDone: boolean
  preset: ProviderPreset | null
  keysUrl?: string
  /** The field the "Get a key" link goes next to. */
  keyField: string | null
  redirects: string[]
  fieldId: (field: string) => string
  onManual: () => void
  onPreset: (preset: ProviderPreset) => void
  onChange: (field: string, value: string) => void
}

/** The provider's keys: its help, the service presets, OpenRouter's sign-in, the fields and the redirect URIs. */
export function ProviderForm(props: FormProps) {
  const { provider, values, errors, canStore, busy, configured, manual, oauthDone, preset, keysUrl, keyField } = props
  const { redirects, fieldId, onManual, onPreset, onChange } = props
  const t = useT()
  const presets = presetsOf(provider)
  return (
    <>
      {helpOf(provider) && provider.category !== 'recording' && <p className="k-field-desc">{helpOf(provider)}</p>}
      {presets.length > 0 && (
        <FormField label={t('admin.providerDialog.service')} description={preset?.help}>
          <div className="adm-presets" role="radiogroup" aria-label={t('admin.providerDialog.service')}>
            {presets.map(p => (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={preset === p}
                className="adm-preset"
                disabled={!canStore}
                onClick={() => onPreset(p)}
              >
                {presetMeta[p.label] && <Logo mark={presetMeta[p.label]!.mark} size={28} />}
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </FormField>
      )}
      {provider.fields.length === 0 && <p className="k-field-desc">{t('admin.providerDialog.nothingToSetUp')}</p>}
      {!manual && !oauthDone && (
        <div className="adm-oauth">
          <Button
            busy={busy}
            variant="primary"
            disabled={busy || !canStore}
            onClick={() => void startOpenRouterConnect()}
            title={t('admin.providerDialog.openrouter.tip', { brand: brandName() })}
          >
            {busy ? t('admin.providerDialog.openrouter.connecting') : t('admin.providerDialog.openrouter.connect')}
          </Button>
          <LinkButton onClick={onManual}>{t('admin.providerDialog.openrouter.manual')}</LinkButton>
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
            keysUrl={field.field === keyField ? keysUrl : undefined}
            keysLabel={
              provider.category === 'sign_in' || provider.category === 'apps'
                ? t('admin.providerDialog.createApp')
                : undefined
            }
            onChange={value => onChange(field.field, value)}
          />
        ))}
      {manual && redirects.length > 0 && <RedirectUris uris={redirects} />}
    </>
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
  const t = useT()
  const { id, provider, field, value, error, disabled, autoFocus, keysUrl, onChange } = props
  const keysLabel = props.keysLabel ?? t('admin.providerDialog.getKey')
  const fromServer = field.source === 'env' && <ServerSet />
  const getKey = keysUrl && (
    <a
      className="k-link adm-getkey"
      href={keysUrl}
      target="_blank"
      rel="noreferrer"
      title={t('admin.providerDialog.opensNewTab')}
    >
      {keysLabel}
    </a>
  )
  const shared = field.key_from && (
    <span className="help" title={t('admin.providerDialog.sharedKeyTip')}>
      {t('admin.providerDialog.sharedKey', { provider: providerSpecs[field.key_from].label })}
    </span>
  )
  const aside =
    fromServer || shared || getKey || (isOptional(provider, field) ? t('admin.providerDialog.optional') : undefined)
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
          placeholder={field.source === 'env' ? t('admin.providerDialog.setOnServer') : undefined}
          autoFocus={autoFocus}
          invalid={!!error}
        />
      ) : isPhone(provider, field) ? (
        // The install's forwarding checks call US businesses, and the server reads ten digits as a US number: the
        // field starts on the US.
        <PhoneInput
          id={id}
          value={value}
          defaultCountry="US"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          invalid={!!error}
          placeholder={field.hint ?? undefined}
          onChange={onChange}
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
  const t = useT()
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (uri: string) =>
    navigator.clipboard.writeText(uri).then(
      () => setCopied(uri),
      () => setCopied(null),
    )
  return (
    <FormField
      label={t('admin.providerDialog.redirects.label')}
      description={t('admin.providerDialog.redirects.description')}
    >
      <ul className="adm-redirects">
        {uris.map(uri => (
          <li key={uri}>
            <code>{uri}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy(uri)}
              title={t('common.copy.copy')}
              aria-label={t('common.copy.copyThis', { text: uri })}
            >
              <Icon name={copied === uri ? 'check' : 'copy'} size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </FormField>
  )
}
