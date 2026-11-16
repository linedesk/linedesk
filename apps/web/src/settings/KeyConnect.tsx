// Connecting a calendar account with a key (calendar.connectWithPassword), checked with the provider before it is
// stored: CalDAV (iCloud, Fastmail, any server: server, user name, app-specific password), Cal.com (API key, and the
// API address when self-hosted), Calendly (personal access token). The dialog opens inside the Assistant page's form,
// so it has no form of its own (a nested one would submit the page): Enter connects.
import type { ConnectWithPasswordData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useState } from 'react'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog, Input, SecretInput } from '../ui/form.tsx'
import { NO_PASSWORD_MANAGER } from '../ui/passwordManager.ts'
import { Button } from '../ui/kit.tsx'
import { CALDAV_SERVICES, type CalDavService, KEY_FORM, type KeyGuide, type KeyProviderId } from './calendarModel.ts'
import { Field } from './fields.tsx'
import { useWriteAction } from './settings-api.ts'

/** Enter in a field connects, and never submits the page around the dialog. */
const enterTo = (submit: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  submit()
}

type Props = { onClose: () => void; onConnected: (connectionId: string) => void }

/** Where the key is made: a button to the exact page (a new tab), and the steps folded away below it. */
function WhereToGetIt({ guide }: { guide: KeyGuide }) {
  const t = useT()
  return (
    <div className="key-guide">
      {guide.url && (
        <a
          className="k-btn k-btn-secondary k-btn-sm"
          href={guide.url}
          target="_blank"
          rel="noreferrer"
          title={t('settings.keyConnect.opensInNewTab')}
        >
          {t(guide.linkLabel ?? 'settings.keyConnect.openSettings')} ↗
        </a>
      )}
      <details>
        <summary>{t('settings.keyConnect.stepByStep')}</summary>
        <ol>
          {guide.steps.map(step => (
            <li key={step}>{t(step)}</li>
          ))}
        </ol>
        {guide.note && <p className="help">{t(guide.note)}</p>}
      </details>
    </div>
  )
}

export function KeyConnectDialog({ provider, ...props }: Props & { provider: KeyProviderId }) {
  return provider === 'caldav' ? (
    <CalDavConnectDialog {...props} />
  ) : (
    <TokenConnectDialog provider={provider} {...props} />
  )
}

/** Sends the connect, and shows the provider's refusal under the key field. */
function useConnectWithKey(onConnected: (connectionId: string) => void) {
  const write = useWriteAction()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function connect(input: { provider: KeyProviderId; serverUrl?: string; username?: string; password: string }) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { connectionId } = await write<ConnectWithPasswordData>('calendar.connectWithPassword', input)
      onConnected(connectionId)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }
  return { error, saving, connect }
}

function Footer({
  onClose,
  saving,
  disabled,
  submit,
}: {
  onClose: () => void
  saving: boolean
  disabled: boolean
  submit: () => void
}) {
  const t = useT()
  return (
    <>
      <Button onClick={onClose}>{t('common.action.cancel')}</Button>
      <Button
        busy={saving}
        variant="primary"
        disabled={saving || disabled}
        onClick={submit}
        title={t('settings.keyConnect.connectHint')}
      >
        {saving ? t('settings.keyConnect.checking') : t('settings.keyConnect.connect')}
      </Button>
    </>
  )
}

/** Cal.com (API key, Cal.com's cloud only) and Calendly (personal access token). */
function TokenConnectDialog({
  provider,
  onClose,
  onConnected,
}: Props & { provider: Exclude<KeyProviderId, 'caldav'> }) {
  const t = useT()
  const form = KEY_FORM[provider]
  const [key, setKey] = useState('')
  const { error, saving, connect } = useConnectWithKey(onConnected)
  const submit = () => {
    if (key.trim()) void connect({ provider, password: key.trim() })
  }
  const onEnter = enterTo(submit)
  return (
    <Dialog
      title={t(form.title)}
      description={t(form.description)}
      onClose={onClose}
      size="sm"
      footer={<Footer onClose={onClose} saving={saving} disabled={!key.trim()} submit={submit} />}
    >
      <Field id="key-connect-key" label={t(form.keyLabel)} help={t(form.help)} error={error}>
        {/* A key, not a password: never saved as this site's login (SecretInput). */}
        <SecretInput
          id="key-connect-key"
          placeholder={form.placeholder}
          value={key}
          invalid={Boolean(error)}
          onChange={setKey}
          onKeyDown={onEnter}
        />
      </Field>
      <WhereToGetIt guide={form.guide} />
    </Dialog>
  )
}

function CalDavConnectDialog({ onClose, onConnected }: Props) {
  const t = useT()
  const [service, setService] = useState<CalDavService>('icloud')
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { error, saving, connect } = useConnectWithKey(onConnected)
  const preset = CALDAV_SERVICES[service]
  const server = service === 'other' ? serverUrl.trim() : preset.serverUrl
  const complete = Boolean(server && username.trim() && password)
  const submit = () => {
    if (complete) void connect({ provider: 'caldav', serverUrl: server, username: username.trim(), password })
  }
  const onEnter = enterTo(submit)
  const serviceOptions: SelectOption<CalDavService>[] = (Object.keys(CALDAV_SERVICES) as CalDavService[]).map(id => ({
    value: id,
    label: t(CALDAV_SERVICES[id].label),
  }))

  return (
    <Dialog
      title={t('settings.keyConnect.caldav.title')}
      description={t('settings.keyConnect.caldav.description')}
      onClose={onClose}
      size="sm"
      footer={<Footer onClose={onClose} saving={saving} disabled={!complete} submit={submit} />}
    >
      <Field id="caldav-service" label={t('settings.keyConnect.caldav.calendar')}>
        <div>
          <Select
            id="caldav-service"
            label={t('settings.keyConnect.caldav.calendar')}
            value={service}
            options={serviceOptions}
            onChange={setService}
          />
        </div>
      </Field>
      {service === 'other' && (
        <Field id="caldav-server" label={t('settings.keyConnect.caldav.server')}>
          <Input
            id="caldav-server"
            inputMode="url"
            {...NO_PASSWORD_MANAGER}
            placeholder={t('settings.keyConnect.caldav.serverExample')}
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            onKeyDown={onEnter}
          />
        </Field>
      )}
      {/* The calendar service's sign-in, not this site's: password managers stay out, so it is not saved as the
          Linedesk login and the password field gets no generated password. */}
      <Field id="caldav-user" label={t(preset.username)}>
        <Input
          id="caldav-user"
          {...NO_PASSWORD_MANAGER}
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={e => setUsername(e.target.value)}
          onKeyDown={onEnter}
        />
      </Field>
      <Field id="caldav-password" label={t('settings.keyConnect.caldav.password')} help={t(preset.help)} error={error}>
        <SecretInput
          id="caldav-password"
          value={password}
          invalid={Boolean(error)}
          onChange={setPassword}
          onKeyDown={onEnter}
        />
      </Field>
      <WhereToGetIt guide={preset.guide} />
    </Dialog>
  )
}
