// Connecting a CalDAV account (iCloud, Fastmail, any CalDAV server): server, user name and an app-specific
// password, checked against the server before it is stored (calendar.connectWithPassword). The dialog opens inside
// the Assistant page's form, so it has no form of its own (a nested one would submit the page): Enter connects.
import type { ConnectWithPasswordData } from '@linedesk/actions'
import { type KeyboardEvent, useState } from 'react'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { CALDAV_SERVICES, type CalDavService } from './calendarModel.ts'
import { Field } from './fields.tsx'
import { useWriteAction } from './settings-api.ts'

const serviceOptions: SelectOption<CalDavService>[] = (Object.keys(CALDAV_SERVICES) as CalDavService[]).map(id => ({
  value: id,
  label: CALDAV_SERVICES[id].label,
}))

/** Enter in a field connects, and never submits the page around the dialog. */
const enterTo = (submit: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  submit()
}

export function CalDavConnectDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void
  onConnected: (connectionId: string) => void
}) {
  const write = useWriteAction()
  const [service, setService] = useState<CalDavService>('icloud')
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const preset = CALDAV_SERVICES[service]
  const server = service === 'other' ? serverUrl.trim() : preset.serverUrl
  const complete = Boolean(server && username.trim() && password)
  const onEnter = enterTo(() => void submit())

  async function submit() {
    if (!complete || saving) return
    setSaving(true)
    setError(null)
    try {
      const { connectionId } = await write<ConnectWithPasswordData>('calendar.connectWithPassword', {
        provider: 'caldav',
        serverUrl: server,
        username: username.trim(),
        password,
      })
      onConnected(connectionId)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="Connect iCloud or CalDAV"
      description="The assistant books into its calendars like any other. The password is stored encrypted."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button busy={saving} variant="primary" disabled={saving || !complete} onClick={() => void submit()} title="Connect (Enter)">
            {saving ? 'Checking…' : 'Connect'}
          </Button>
        </>
      }
    >
      <Field id="caldav-service" label="Calendar">
        <div>
          <Select id="caldav-service" label="Calendar" value={service} options={serviceOptions} onChange={setService} />
        </div>
      </Field>
      {service === 'other' && (
        <Field id="caldav-server" label="Server address">
          <Input
            id="caldav-server"
            inputMode="url"
            autoComplete="url"
            placeholder="https://cloud.example.com/remote.php/dav"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            onKeyDown={onEnter}
          />
        </Field>
      )}
      <Field id="caldav-user" label={preset.username}>
        <Input
          id="caldav-user"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={e => setUsername(e.target.value)}
          onKeyDown={onEnter}
        />
      </Field>
      <Field id="caldav-password" label="App-specific password" help={preset.help} error={error}>
        <Input
          id="caldav-password"
          type="password"
          autoComplete="new-password"
          value={password}
          invalid={Boolean(error)}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={onEnter}
        />
      </Field>
    </Dialog>
  )
}
