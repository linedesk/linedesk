// Workspace settings › General: what is the same for the whole workspace. The business name (workspace.rename),
// the workspace icon (WorkspaceIconField), the country (Automatic until set: workspace-locale.ts), the time zone (moved here from the assistant's Advanced section;
// Hours & holidays links here) and the value of a booked appointment (also set from the Insights summary). Owners and admins change them; members see them.
import { useReadOnlyNote } from './readOnly.ts'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@linedesk/i18n/react'
import { showAppointmentValue } from '../insights/Insights.tsx'
import { useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { AgentChangeNote } from './AgentChange.tsx'
import { AppointmentValue } from './AppointmentValue.tsx'
import { TimeZoneSelect } from './BusinessHours.tsx'
import { Field, Section, SwitchRow } from './fields.tsx'
import { rejectionText } from '../shell/rejections.ts'
import { pricePerMinute } from './levelModel.ts'
import { refreshQuery } from '../cachedQuery.ts'
import { type AllowPremiumData, type AllowUltraData, USAGE_CENTS_PER_MINUTE } from '@linedesk/actions'
import {
  callAction,
  patchWorkspaceSettings,
  refreshWorkspaceSettings,
  useWorkspaceSettings,
  useWriteAction,
} from './settings-api.ts'
import { renameCheck, saveRename } from './workspaceGeneral.ts'
import { CountrySelect } from './CountrySelect.tsx'
import { AUTOMATIC } from './workspaceLocaleModel.ts'
import { WorkspaceIconField } from './WorkspaceIconField.tsx'

type Props = {
  canEdit: boolean
  name: string
  /** After a rename: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

/**
 * General: the business name, icon, country, time zone and appointment value. On top, for owners and admins
 * (`agentChange`), the offer to change them with an AI agent (AgentChange.tsx): the section the page opens at, and the
 * one whose settings an agent can change (the team, numbers, recordings, API keys and the danger zone it cannot).
 */
export function WorkspaceGeneral({
  canEdit,
  agentChange = false,
  isOwner = false,
  name,
  onRenamed,
  toast,
}: Props & { agentChange?: boolean; isOwner?: boolean }) {
  const t = useT()
  const readOnly = useReadOnlyNote()
  return (
    <Section id="ws-general" title={t('settings.workspace.nav.general.label')}>
      {agentChange && <AgentChangeNote target={{ kind: 'workspace' }} firstField="ws-name" />}
      <BusinessName canEdit={canEdit} name={name} onRenamed={onRenamed} toast={toast} />
      <WorkspaceIconField canEdit={canEdit} name={name} readOnlyNote={readOnly} toast={toast} />
      <Country canEdit={canEdit} />
      <TimeZone canEdit={canEdit} />
      <Value canEdit={canEdit} toast={toast} />
      <AllowPremium isOwner={isOwner} canEdit={canEdit} toast={toast} />
      <AllowUltra isOwner={isOwner} canEdit={canEdit} toast={toast} />
    </Section>
  )
}

/** The business name (the workspace's name): saved on Enter or when the field loses focus; Esc puts it back. */
function BusinessName({ canEdit, name, onRenamed, toast }: Props) {
  const t = useT()
  const write = useWriteAction()
  const readOnly = useReadOnlyNote()
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
    <Field
      id="ws-name"
      label={t('settings.general.name.label')}
      help={canEdit ? undefined : readOnly}
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
  const readOnly = useReadOnlyNote()
  const settings = useWorkspaceSettings()
  const data = settings.data
  const automatic = useMemo(
    () => ({ country: data?.resolvedCountry ?? 'US', source: data?.countrySource ?? ('default' as const) }),
    [data?.resolvedCountry, data?.countrySource],
  )
  const change = (value: string) => {
    const country = value === AUTOMATIC ? null : value
    patchWorkspaceSettings({ country, ...(country ? { resolvedCountry: country, countrySource: 'explicit' } : {}) })
    void saveCountry({ country })
  }
  return (
    <Field
      id="ws-country"
      label={t('settings.general.country.label')}
      help={canEdit ? undefined : readOnly}
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

/** The workspace's time zone: the date and time the assistant is told, and what business hours mean. Saves at once. */
function TimeZone({ canEdit }: { canEdit: boolean }) {
  const t = useT()
  const readOnly = useReadOnlyNote()
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
      help={canEdit ? undefined : readOnly}
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
  const readOnly = useReadOnlyNote()
  const query = useWorkspaceSettings()
  const settings = query.data
  return (
    <Field
      id="ws-appointment-value"
      label={t('settings.general.value.label')}
      help={canEdit ? undefined : readOnly}
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

/**
 * Linedesk Cloud: the owner allows Premium voices and models for the workspace's assistants (workspace.setAllowPremium).
 * Only on an install that bills usage; only the owner changes it. Off moves assistants on Premium back to Standard.
 */
function AllowPremium({
  isOwner,
  canEdit,
  toast,
}: {
  isOwner: boolean
  canEdit: boolean
  toast: (text: string) => void
}) {
  const t = useT()
  const readOnly = useReadOnlyNote()
  const write = useWriteAction()
  const settings = useWorkspaceSettings().data
  const [busy, setBusy] = useState(false)
  if (!settings?.usageLevels) return null
  const prices = {
    standard: pricePerMinute(USAGE_CENTS_PER_MINUTE.standard),
    premium: pricePerMinute(USAGE_CENTS_PER_MINUTE.premium),
  }

  async function change(on: boolean) {
    setBusy(true)
    try {
      const data = await write<AllowPremiumData>('workspace.setAllowPremium', { on })
      patchWorkspaceSettings({ allowPremium: data.on })
      void refreshQuery('voice.options')
      toast(
        data.on
          ? t('settings.general.premium.on')
          : t('settings.general.premium.off', { count: data.movedToStandard.length }),
      )
    } catch (e) {
      toast(rejectionText('workspace.setAllowPremium', (e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SwitchRow
      title={t('settings.general.premium.label')}
      description={
        !isOwner
          ? t('settings.general.premium.ownerOnly', prices)
          : canEdit
            ? t('settings.general.premium.help', prices)
            : readOnly
      }
      on={settings.allowPremium}
      onChange={on => void change(on)}
      disabled={!isOwner || !canEdit || busy}
    />
  )
}

/**
 * Linedesk Cloud: the owner allows Ultra, calls answered by a realtime model (workspace.setAllowUltra). Like Allow
 * Premium: only on an install that bills usage, only the owner changes it. Off moves those assistants back to the three
 * stages.
 */
function AllowUltra({
  isOwner,
  canEdit,
  toast,
}: {
  isOwner: boolean
  canEdit: boolean
  toast: (text: string) => void
}) {
  const t = useT()
  const readOnly = useReadOnlyNote()
  const write = useWriteAction()
  const settings = useWorkspaceSettings().data
  const [busy, setBusy] = useState(false)
  if (!settings?.usageLevels) return null
  const prices = {
    standard: pricePerMinute(USAGE_CENTS_PER_MINUTE.standard),
    ultra: pricePerMinute(USAGE_CENTS_PER_MINUTE.ultra),
  }

  async function change(on: boolean) {
    setBusy(true)
    try {
      const data = await write<AllowUltraData>('workspace.setAllowUltra', { on })
      patchWorkspaceSettings({ allowUltra: data.on })
      void refreshQuery('voice.options')
      toast(
        data.on ? t('settings.general.ultra.on') : t('settings.general.ultra.off', { count: data.movedOffUltra.length }),
      )
    } catch (e) {
      toast(rejectionText('workspace.setAllowUltra', (e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SwitchRow
      title={t('settings.general.ultra.label')}
      description={
        !isOwner
          ? t('settings.general.ultra.ownerOnly', prices)
          : canEdit
            ? t('settings.general.ultra.help', prices)
            : readOnly
      }
      on={settings.allowUltra}
      onChange={on => void change(on)}
      disabled={!isOwner || !canEdit || busy}
    />
  )
}
