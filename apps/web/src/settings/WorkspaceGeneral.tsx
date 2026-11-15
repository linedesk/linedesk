// Workspace settings › General: what is the same for the whole workspace. The business name (workspace.rename),
// the workspace icon (WorkspaceIconField), the country and language (Automatic until set: workspace-locale.ts), the time zone (moved here from the assistant's Advanced section;
// Hours & holidays links here) and the value of a booked appointment (also set from the Insights summary). Owners and admins change them; members see them.
import { onlyAdmins } from './readOnly.ts'
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { T, useLocale, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { showAppointmentValue } from '../insights/Insights.tsx'
import { useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { SearchSelect } from '../ui/SearchSelect.tsx'
import { sectionHash } from '../ui/SettingsLayout.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { AgentChangeNote } from './AgentChange.tsx'
import { AppointmentValue } from './AppointmentValue.tsx'
import { TimeZoneSelect } from './BusinessHours.tsx'
import { Field, Section } from './fields.tsx'
import { callAction, patchWorkspaceSettings, refreshWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { renameCheck } from './workspaceGeneral.ts'
import { CountrySelect } from './CountrySelect.tsx'
import { AUTOMATIC, languageOptions } from './workspaceLocaleModel.ts'
import { WorkspaceIconField } from './WorkspaceIconField.tsx'

/** Where an assistant's languages and voice are (the workspace's first assistant, AssistantSettings.tsx). */
const ASSISTANT_GENERAL = sectionHash('assistant', 'general')

type Props = {
  canEdit: boolean
  name: string
  /** After a rename: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

/**
 * General: the business name, icon, country, language, time zone and appointment value. On top, for owners and admins
 * (`agentChange`), the offer to change them with an AI agent (AgentChange.tsx): the section the page opens at, and the
 * one whose settings an agent can change (the team, numbers, recordings, API keys and the danger zone it cannot).
 */
export function WorkspaceGeneral({
  canEdit,
  agentChange = false,
  name,
  onRenamed,
  toast,
}: Props & { agentChange?: boolean }) {
  const t = useT()
  return (
    <Section id="ws-general" title={t('settings.workspace.nav.general.label')}>
      {agentChange && <AgentChangeNote target={{ kind: 'workspace' }} firstField="ws-name" />}
      <BusinessName canEdit={canEdit} name={name} onRenamed={onRenamed} toast={toast} />
      <WorkspaceIconField canEdit={canEdit} name={name} readOnlyNote={onlyAdmins()} toast={toast} />
      <Country canEdit={canEdit} />
      <Language canEdit={canEdit} />
      <TimeZone canEdit={canEdit} />
      <Value canEdit={canEdit} toast={toast} />
    </Section>
  )
}

/** The business name (the workspace's name): saved on Enter or when the field loses focus; Esc puts it back. */
function BusinessName({ canEdit, name, onRenamed, toast }: Props) {
  const t = useT()
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
    toast(t('settings.general.name.renamed', { name: next }))
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
      label={t('settings.general.name.label')}
      help={canEdit ? undefined : onlyAdmins()}
      tip={t('settings.general.name.tip')}
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
  const t = useT()
  const settings = useWorkspaceSettings()
  const data = settings.data
  const automatic = useMemo(
    () => ({ country: data?.resolvedCountry ?? 'US', source: data?.countrySource ?? ('default' as const) }),
    [data?.resolvedCountry, data?.countrySource],
  )
  const change = (value: string) => {
    const country = value === AUTOMATIC ? null : value
    patchWorkspaceSettings({ country, ...(country ? { resolvedCountry: country, countrySource: 'explicit' } : {}) })
    void saveLocale({ country })
  }
  return (
    <Field
      id="ws-country"
      label={t('settings.general.country.label')}
      help={canEdit ? undefined : onlyAdmins()}
      tip={t('settings.general.country.tip')}
    >
      <Loading
        what={t('settings.general.country.what')}
        loading={!data}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {data && (
          <CountrySelect
            id="ws-country"
            value={data.country ?? AUTOMATIC}
            automatic={automatic}
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
  const t = useT()
  const ui = useLocale()
  const options = useMemo(() => languageOptions(country, ui), [country, ui])
  const change = (value: string) => {
    const language = value === AUTOMATIC ? null : value
    patchWorkspaceSettings({ language, ...(language ? { resolvedLanguage: language } : {}) })
    void saveLocale({ language })
  }
  return (
    <Field
      id="ws-language"
      label={t('settings.general.language.label')}
      help={
        <T
          k={canEdit ? 'settings.general.language.help' : 'settings.general.language.helpReadOnly'}
          values={{ link: appLink(sectionHash('account', 'preferences')) }}
        />
      }
      tip={{
        text: (
          <T
            k="settings.general.language.tip"
            values={{ languages: appLink(ASSISTANT_GENERAL), voice: appLink(ASSISTANT_GENERAL) }}
          />
        ),
      }}
    >
      <Loading
        what={t('settings.general.language.what')}
        loading={!data}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {data && (
          <SearchSelect
            id="ws-language"
            label={t('settings.general.language.label')}
            value={data.language ?? AUTOMATIC}
            options={options}
            placeholder={t('settings.general.language.search')}
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
  const t = useT()
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
      label={t('settings.general.timeZone.label')}
      help={canEdit ? undefined : onlyAdmins()}
      tip={t('settings.general.timeZone.tip')}
    >
      <Loading
        what={t('settings.general.timeZone.what')}
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
  const t = useT()
  const query = useWorkspaceSettings()
  const settings = query.data
  return (
    <Field
      id="ws-appointment-value"
      label={t('settings.general.value.label')}
      help={canEdit ? undefined : onlyAdmins()}
      tip={t('settings.general.value.tip')}
    >
      <Loading
        what={t('settings.general.value.what')}
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
