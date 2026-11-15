// Workspace settings › General: what is the same for the whole workspace. The business name (workspace.rename),
// the workspace icon (WorkspaceIconField), the time zone (moved here from the assistant's Advanced section;
// Hours & holidays links here) and the value of a booked appointment (also set from the Insights summary). Owners and admins change them; members see them.
import { ONLY_ADMINS } from './readOnly.ts'
import { type KeyboardEvent, useEffect, useState } from 'react'
import { showAppointmentValue } from '../insights/Insights.tsx'
import { useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { AppointmentValue } from './AppointmentValue.tsx'
import { TimeZoneSelect } from './BusinessHours.tsx'
import { Field, Section } from './fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { renameCheck } from './workspaceGeneral.ts'
import { WorkspaceIconField } from './WorkspaceIconField.tsx'

const READ_ONLY = ONLY_ADMINS

type Props = {
  canEdit: boolean
  name: string
  /** After a rename: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

export function WorkspaceGeneral({ canEdit, name, onRenamed, toast }: Props) {
  return (
    <Section id="ws-general" title="General">
      <BusinessName canEdit={canEdit} name={name} onRenamed={onRenamed} toast={toast} />
      <WorkspaceIconField canEdit={canEdit} name={name} readOnlyNote={READ_ONLY} toast={toast} />
      <TimeZone canEdit={canEdit} />
      <Value canEdit={canEdit} toast={toast} />
    </Section>
  )
}

/** The business name (the workspace's name): saved on Enter or when the field loses focus; Esc puts it back. */
function BusinessName({ canEdit, name, onRenamed, toast }: Props) {
  const run = useRun()
  const [draft, setDraft] = useState(name)
  // Renamed elsewhere (another tab, onboarding): the field follows.
  useEffect(() => setDraft(name), [name])
  const { next, changed, problem } = renameCheck(draft, name)

  function save() {
    if (!changed || problem) return
    void run('workspace.rename', { name: next })
    onRenamed(next)
    setDraft(next)
    toast(`Renamed to ${next}.`)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape' && draft !== name) {
      e.stopPropagation() // Esc puts the name back; it does not leave the page
      setDraft(name)
    }
  }

  return (
    <Field
      id="ws-name"
      label="Business name"
      help={canEdit ? undefined : READ_ONLY}
      tip="Shown in the menu, the workspace switcher and emails."
      error={problem}
    >
      <Input
        id="ws-name"
        value={draft}
        readOnly={!canEdit}
        invalid={!!problem}
        autoComplete="organization"
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={save}
      />
    </Field>
  )
}

/** The workspace's time zone: the date and time the assistant is told, and what business hours mean. Saves at once. */
function TimeZone({ canEdit }: { canEdit: boolean }) {
  const run = useRun()
  const settings = useWorkspaceSettings()
  const zone = settings.data?.timeZone
  const change = (timeZone: string) => {
    patchWorkspaceSettings({ timeZone })
    void run('workspace.updateSettings', { timeZone })
  }
  return (
    <Field
      id="ws-time-zone"
      label="Time zone"
      help={canEdit ? undefined : READ_ONLY}
      tip="Where the business is. The assistant is told today's date and the time here; business hours and bookings use it too."
    >
      <Loading
        what="The time zone"
        loading={!zone}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {zone && <TimeZoneSelect id="ws-time-zone" value={zone} onChange={change} disabled={!canEdit} />}
      </Loading>
    </Field>
  )
}

/** What one booked appointment is worth on average: Insights multiplies it by the booked appointments. */
function Value({ canEdit, toast }: { canEdit: boolean; toast: (text: string) => void }) {
  const query = useWorkspaceSettings()
  const settings = query.data
  return (
    <Field
      id="ws-appointment-value"
      label="Appointment value"
      help={canEdit ? undefined : READ_ONLY}
      tip="What one booked appointment is worth to you on average. Insights shows what the booked appointments are worth."
    >
      <Loading
        what="The appointment value"
        loading={!settings}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={
          <span className="sk-inline">
            <Skeleton shape="field" width={185} />
            <Skeleton shape="field" width={82} />
          </span>
        }
      >
        {settings && (
          <AppointmentValue
            id="ws-appointment-value"
            value={settings.jobValueCents}
            currency={settings.jobValueCurrency ?? 'USD'}
            canEdit={canEdit}
            onSaved={(cents, currency) => showAppointmentValue(cents, currency)}
            toast={toast}
          />
        )}
      </Loading>
    </Field>
  )
}
