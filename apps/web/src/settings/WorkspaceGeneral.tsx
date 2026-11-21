// Workspace settings › General: what is the same for the whole workspace. The business name (workspace.rename), the kind of business (LIN-680),
// the workspace icon (WorkspaceIconField), the country (Automatic until set: workspace-locale.ts), the time zone (moved here from the assistant's Advanced section;
// Hours & holidays links here) and the value of a booked appointment (also set from the Insights summary). Owners and admins change them; members see them, with one note on top saying why they can't.
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@linedesk/i18n/react'
import { showAppointmentValue } from '../insights/Insights.tsx'
import { useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { AppointmentValue } from './AppointmentValue.tsx'
import { TimeZoneSelect } from './BusinessHours.tsx'
import { Field, FollowsLine, ReadOnlyNote, Section } from './fields.tsx'
import { rejectionText } from '../shell/rejections.ts'
import {
  callAction,
  patchWorkspaceSettings,
  refreshWorkspaceSettings,
  useWorkspaceSettings,
  useWriteAction,
} from './settings-api.ts'
import { renameCheck, saveRename } from './workspaceGeneral.ts'
import { CountrySelect } from './CountrySelect.tsx'
import { timeZoneLabel } from './timeZones.ts'
import { AUTOMATIC, explicitCountryPatch } from './workspaceLocaleModel.ts'
import { WorkspaceIconField } from './WorkspaceIconField.tsx'
import type { BusinessKind } from '@linedesk/actions'
import { refreshGoLiveChecklist } from '../inbox/GoLiveChecklist.tsx'
import { Select } from '../ui/controls.tsx'
import { kindOptions } from './businessKind.ts'

type Props = {
  canEdit: boolean
  name: string
  /** After a rename: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

/**
 * General: the business name, icon, country, time zone and appointment value: the section the page opens at, and the
 * one whose settings an AI agent can change (the top bar's "Edit with AI", AgentChange.tsx; the team, numbers,
 * recordings, API keys and the danger zone it cannot).
 */
export function WorkspaceGeneral({ canEdit, name, onRenamed, toast }: Props) {
  const t = useT()
  return (
    <Section id="ws-general" title={t('settings.workspace.nav.general.label')}>
      {/* Members: why nothing here can change, once at the top, not under every field. */}
      {!canEdit && <ReadOnlyNote />}
      <BusinessName canEdit={canEdit} name={name} onRenamed={onRenamed} toast={toast} />
      {/* The note above says it for every field: none of its own under the icon. */}
      <WorkspaceIconField canEdit={canEdit} name={name} readOnlyNote="" toast={toast} />
      <Kind canEdit={canEdit} />
      <Country canEdit={canEdit} />
      <TimeZone canEdit={canEdit} />
      <Value canEdit={canEdit} toast={toast} />
    </Section>
  )
}

/** The business name (the workspace's name): saved on Enter or when the field loses focus; Esc puts it back. */
function BusinessName({ canEdit, name, onRenamed, toast }: Props) {
  const t = useT()
  const write = useWriteAction()
  const [draft, setDraft] = useState(name)
  // Renamed elsewhere (another tab, onboarding): the field follows.
  useEffect(() => setDraft(name), [name])
  const { next, changed, problem } = renameCheck(draft, name)
  // Enter and then leaving the field send one rename, not two.
  const saving = useRef(false)

  // The name is the session's, not a synced row: it changes on screen once the server has saved it.
  function save() {
    if (!changed || problem || saving.current) return
    saving.current = true
    void saveRename(next, {
      write: renamed => write('workspace.rename', { name: renamed }),
      saved: renamed => {
        onRenamed(renamed)
        setDraft(renamed)
        toast(t('settings.general.name.renamed', { name: renamed }))
      },
      refused: reason => {
        setDraft(name)
        toast(rejectionText('workspace.rename', reason))
      },
    }).finally(() => {
      saving.current = false
    })
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
    <Field id="ws-name" label={t('settings.general.name.label')} tip={t('settings.general.name.tip')} error={problem}>
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
 * Saves the country, then reads the settings again: what Automatic stands for, the language that follows the country
 * and the currency of an unset appointment value are worked out by the API.
 */
async function saveCountry(change: { country: string | null }) {
  try {
    await callAction('workspace.updateSettings', change)
  } catch (e) {
    console.warn(`could not save the workspace country: ${(e as Error).message}`)
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
    patchWorkspaceSettings(country ? explicitCountryPatch(country) : { country })
    void saveCountry({ country })
  }
  return (
    <Field id="ws-country" label={t('settings.general.country.label')} tip={t('settings.general.country.tip')}>
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
            served={data.servedCountries}
            onChange={change}
            disabled={!canEdit}
          />
        )}
      </Loading>
    </Field>
  )
}

/**
 * Saves a setting put back to following the country, then reads the settings again: the value it now has (the
 * country's main time zone, its currency) is worked out by the API.
 */
async function saveFollow(change: { timeZone: null } | { jobValueCurrency: null }) {
  try {
    await callAction('workspace.updateSettings', change)
  } catch (e) {
    console.warn(`could not go back to the country default: ${(e as Error).message}`)
  }
  void refreshWorkspaceSettings()
}

/**
 * The kind of business (LIN-680): picked in onboarding; it decides which go-live steps show (a calendar, Shopify, a
 * support mailbox). Saves at once; the checklist is read again so its steps follow.
 */
function Kind({ canEdit }: { canEdit: boolean }) {
  const t = useT()
  const write = useWriteAction()
  const settings = useWorkspaceSettings()
  const data = settings.data
  const change = (businessKind: BusinessKind | typeof NO_KIND) => {
    if (!businessKind || businessKind === data?.businessKind) return
    patchWorkspaceSettings({ businessKind })
    // Saved, then the go-live checklist is read again: its steps follow the new kind without a reload.
    void write('workspace.updateSettings', { businessKind })
      .then(() => refreshGoLiveChecklist())
      .catch(e => {
        console.warn(`could not save the kind of business: ${(e as Error).message}`)
        void refreshWorkspaceSettings()
      })
  }
  return (
    <Field id="ws-kind" label={t('settings.general.kind.label')} tip={t('settings.general.kind.tip')}>
      <Loading
        what={t('settings.general.kind.what')}
        loading={!data}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {data && (
          <Select<BusinessKind | typeof NO_KIND>
            id="ws-kind"
            label={t('settings.general.kind.label')}
            value={data.businessKind ?? NO_KIND}
            options={kindOptions()}
            onChange={change}
            disabled={!canEdit}
          />
        )}
      </Loading>
    </Field>
  )
}
/** "Choose…" while no kind was ever picked (a workspace from before kinds). */
const NO_KIND = ''

/**
 * The workspace's time zone: the date and time the assistant is told, and what business hours mean. It follows the
 * country (moves into it when the country changes) until one is picked here. Saves at once.
 */
function TimeZone({ canEdit }: { canEdit: boolean }) {
  const t = useT()
  const run = useRun()
  const settings = useWorkspaceSettings()
  const data = settings.data
  const zone = data?.timeZone
  const change = (timeZone: string) => {
    if (timeZone === zone) return
    patchWorkspaceSettings({ timeZone, timeZoneFollowsCountry: false })
    void run('workspace.updateSettings', { timeZone })
  }
  const followCountry = () => {
    patchWorkspaceSettings({
      timeZoneFollowsCountry: true,
      ...(data?.countryTimeZone ? { timeZone: data.countryTimeZone } : {}),
    })
    void saveFollow({ timeZone: null })
  }
  return (
    <Field id="ws-time-zone" label={t('settings.general.timeZone.label')} tip={t('settings.general.timeZone.tip')}>
      <Loading
        what={t('settings.general.timeZone.what')}
        loading={!zone}
        error={settings.error}
        onRetry={() => void settings.reload()}
        skeleton={<Skeleton shape="field" width="100%" />}
      >
        {zone && (
          <TimeZoneSelect
            id="ws-time-zone"
            value={zone}
            onChange={change}
            disabled={!canEdit}
            countryDefault={data?.countryTimeZone}
          />
        )}
        {zone && data?.timeZoneFollowsCountry !== undefined && (
          <FollowsLine
            source="country"
            follows={data.timeZoneFollowsCountry}
            sourceDefault={timeZoneLabel(data.countryTimeZone ?? zone)}
            controlId="ws-time-zone"
            onReset={canEdit && data.countryTimeZone ? followCountry : undefined}
          />
        )}
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
    <Field id="ws-appointment-value" label={t('settings.general.value.label')} tip={t('settings.general.value.tip')}>
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
            countryDefault={settings.countryCurrency}
            canEdit={canEdit}
            onSaved={(cents, currency) => showAppointmentValue(cents, currency)}
            toast={toast}
          />
        )}
        {settings?.jobValueCurrencyFollowsCountry !== undefined && (
          <FollowsLine
            source="country"
            what="currency"
            controlId="ws-appointment-value"
            follows={settings.jobValueCurrencyFollowsCountry}
            sourceDefault={settings.countryCurrency ?? 'USD'}
            onReset={
              canEdit && settings.countryCurrency
                ? () => {
                    patchWorkspaceSettings({ jobValueCurrencyFollowsCountry: true })
                    void saveFollow({ jobValueCurrency: null })
                  }
                : undefined
            }
          />
        )}
      </Loading>
    </Field>
  )
}
