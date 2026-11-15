// Workspace settings › General: what is the same for the whole workspace. The business name (workspace.rename),
// the workspace icon (WorkspaceIconField), the country and language (Automatic until set: workspace-locale.ts), the time zone (moved here from the assistant's Advanced section;
// Hours & holidays links here) and the value of a booked appointment (also set from the Insights summary). Owners and admins change them; members see them.
import { ONLY_ADMINS } from './readOnly.ts'
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { showAppointmentValue } from '../insights/Insights.tsx'
import { useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { SearchSelect } from '../ui/SearchSelect.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { AppointmentValue } from './AppointmentValue.tsx'
import { TimeZoneSelect } from './BusinessHours.tsx'
import { Field, Section } from './fields.tsx'
import { callAction, patchWorkspaceSettings, refreshWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { renameCheck } from './workspaceGeneral.ts'
import { AUTOMATIC, countryOptions, languageOptions, searchCountries } from './workspaceLocaleModel.ts'
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
      <Country canEdit={canEdit} />
      <Language canEdit={canEdit} />
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

/**
 * Saves the country or language, then reads the settings again: what Automatic stands for, the language that follows
 * the country and the currency of an unset appointment value are worked out by the API.
 */
async function saveLocale(change: { country?: string | null; language?: string | null }) {
  try {
    await callAction('workspace.updateSettings', change)
  } catch (e) {
    console.warn(`could not save the workspace ${Object.keys(change).join(' and ')}: ${(e as Error).message}`)
  }
  // Also after a failure: the field goes back to what is saved.
  void refreshWorkspaceSettings()
}

/**
 * Where the business is: the default country of phone numbers, the forwarding guide, the holidays and the currency, and
 * how the assistant reads numbers callers say. Automatic until set: from the assistant's number, the business phone or
 * the holiday calendar, else the United States. Saves at once.
 */
function Country({ canEdit }: { canEdit: boolean }) {
  const settings = useWorkspaceSettings()
  const data = settings.data
  const resolved = data?.resolvedCountry ?? 'US'
  const options = useMemo(
    () => countryOptions(resolved, data?.countrySource ?? 'default'),
    [resolved, data?.countrySource],
  )
  const change = (value: string) => {
    const country = value === AUTOMATIC ? null : value
    patchWorkspaceSettings({ country, ...(country ? { resolvedCountry: country, countrySource: 'explicit' } : {}) })
    void saveLocale({ country })
  }
  return (
    <Field
      id="ws-country"
      label="Country"
      help={canEdit ? undefined : READ_ONLY}
      tip="Where the business is. Phone numbers, the forwarding guide, holidays and the currency start with it, and the assistant reads the numbers callers say the way they are written there."
    >
      <Loading
        what="The country"
        loading={!data}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {data && (
          <SearchSelect
            id="ws-country"
            label="Country"
            value={data.country ?? AUTOMATIC}
            options={options}
            search={searchCountries}
            placeholder="Search a country"
            onChange={change}
            disabled={!canEdit}
          />
        )}
      </Loading>
    </Field>
  )
}

/**
 * The workspace language: what assistants without a main language of their own greet and speak in, and what call
 * summaries and messages for the team are written in. Only the languages calls can be answered in. Saves at once.
 */
function Language({ canEdit }: { canEdit: boolean }) {
  const settings = useWorkspaceSettings()
  const data = settings.data
  const country = data?.resolvedCountry ?? 'US'
  const options = useMemo(() => languageOptions(country), [country])
  const change = (value: string) => {
    const language = value === AUTOMATIC ? null : value
    patchWorkspaceSettings({ language, ...(language ? { resolvedLanguage: language } : {}) })
    void saveLocale({ language })
  }
  return (
    <Field
      id="ws-language"
      label="Language"
      help={canEdit ? undefined : READ_ONLY}
      tip="Your assistant greets callers in it unless it has its own main language (Settings › Assistant › Languages), and call summaries are written in it. Every voice speaks every language listed; Settings › Assistant › Voice suggests voices native in it."
    >
      <Loading
        what="The language"
        loading={!data}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {data && (
          <SearchSelect
            id="ws-language"
            label="Language"
            value={data.language ?? AUTOMATIC}
            options={options}
            placeholder="Search a language"
            onChange={change}
            disabled={!canEdit}
          />
        )}
      </Loading>
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
