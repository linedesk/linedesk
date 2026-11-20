// Settings › Assistant › Booking & calendar. Each setting has one place: a summary in plain words on top; "How the
// assistant books" (shown once a Cal.com or Calendly account is connected): with its own calendars, or with the event
// types of one scheduling tool account, never both (LIN-355; the server refuses a mix); then 1 "Appointment types"
// (the workspace's own appointment types, or that account's event types, unused ones switched off), 2 "Activated
// calendars" (own calendars only: on or off, a note on when to use each, one default; "Choose calendars"
// opens one account's picker; a tool puts bookings in its own calendars), and the calendar accounts folded away at the
// bottom (add, connect again, disconnect). Changes apply at once (not
// part of the page's Save): connecting leaves the page for the provider's consent screen anyway (or checks a key in
// a dialog), and the rest are small, single changes through the outbox.
import type { ConnectStartData, DisconnectData, ListCalendarsData } from '@linedesk/actions'
import { BOOKING_MODE_REFUSED, bookingMode, CONDITION_MAX, fitsBookingMode, TOOL_MAX_WAIT_MS } from '@linedesk/actions'
import type { AppointmentType, Assistant, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { intlLocale } from '../i18n/format.ts'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { useRows, useRun } from '../store.tsx'
import { LinkButton } from '../ui/AppLink.tsx'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Checkbox, RadioCard, Switch } from '../ui/controls.tsx'
import { Card, Dialog, Input } from '../ui/form.tsx'
import { Badge, Button, Icon } from '../ui/kit.tsx'
import { EditButton, List, ListEmpty, ListRow, MenuButton } from '../ui/list.tsx'
import { Loading, SkeletonList, useLoadState } from '../ui/LoadStates.tsx'
import { bold, boldList, SummaryCard } from '../ui/SummaryCard.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { AppointmentTypeDialog } from './AppointmentTypeDialog.tsx'
import { useCalendarConnectWays } from './calendar-providers.ts'
import {
  accountMark,
  CONNECT_RETURN_KEY,
  calendarsOf,
  connectMark,
  connectResult,
  durationLabel,
  isPasswordProvider,
  isSchedulingTool,
  type KeyProviderId,
  PROVIDER_LABEL,
  pickChanges,
  type ProviderId,
  requiredLabel,
  rulesLabel,
  toolTypeRows,
} from './calendarModel.ts'
import { Field } from './fields.tsx'
import { KeyConnectDialog } from './KeyConnect.tsx'
import { MissingProviderNote } from './MissingProviderNote.tsx'
import { callAction, useWriteAction } from './settings-api.ts'
import './calendar.css'

type Props = { assistant: Assistant; canEdit: boolean; toast: (text: string) => void }
type Listed = ListCalendarsData['calendars'][number]
type Connector = ReturnType<typeof useConnect>

/** What the OAuth callback writes: the page reads them again on return before showing them. */
const CONNECT_TABLES = ['calendar_connections', 'assistant_calendars'] as const

const byCreated = <R extends { created_at: string }>(a: R, b: R) => a.created_at.localeCompare(b.created_at)

/** Whether the calendar accounts and calendars can be shown yet (loaded, and not from before a connect). */
function useCalendarsReady(): boolean {
  const accounts = useLoadState('calendar_connections')
  const calendars = useLoadState('assistant_calendars')
  return accounts === 'ready' && calendars === 'ready'
}

/**
 * Connecting an account: opens the provider's consent page, and the callback brings the browser back
 * to this app; a key provider (CalDAV, Cal.com, Calendly) opens `dialog` instead, and `onConnected` gets the new
 * account. `busy` is the provider whose page is opening.
 */
function useConnect(assistantId: string, toast: (text: string) => void, onConnected?: (connectionId: string) => void) {
  const t = useT()
  const connectable = useCalendarConnectWays()
  const providers = connectable?.providers ?? null
  const [busy, setBusy] = useState<ProviderId | null>(null)
  const [askKey, setAskKey] = useState<KeyProviderId | null>(null)

  async function connect(provider: ProviderId) {
    // A key form, or the provider's consent page: as Server admin set it up.
    if (isPasswordProvider(provider) && connectable?.ways[provider] !== 'oauth') {
      setAskKey(provider)
      return
    }
    setBusy(provider)
    try {
      const { url } = await callAction<ConnectStartData>('calendar.connectStart', { provider })
      try {
        sessionStorage.setItem(CONNECT_RETURN_KEY, assistantId)
      } catch {}
      refreshOnReturn(CONNECT_TABLES)
      window.location.assign(url)
    } catch (e) {
      toast((e as Error).message)
      setBusy(null)
    }
  }
  const dialog = askKey && (
    <KeyConnectDialog
      provider={askKey}
      onClose={() => setAskKey(null)}
      onConnected={connectionId => {
        setAskKey(null)
        toast(t('settings.calendar.connected'))
        onConnected?.(connectionId)
      }}
    />
  )
  return { providers, busy, connect, dialog }
}

/**
 * What the OAuth callback said, read on the first render (so the picker opens with the page), shown
 * once as a toast and then taken out of the address. Returns the account just connected ('' when
 * the callback did not name it), or null.
 */
function useConnectResult(toast: (text: string) => void): string | null {
  const [result] = useState(() => connectResult(window.location.hash))
  useEffect(() => {
    if (!result) return
    toast(result.text)
    history.replaceState(null, '', window.location.hash.split('?')[0])
  }, [result, toast])
  return result?.ok ? (result.connectionId ?? '') : null
}

/** The calendars (or event types) of an account the assistant can book into; cached, shared by picker and list. */
function useCalendarList(connectionId: string) {
  return useQuery(`calendar.list.${connectionId}`, () =>
    callAction<ListCalendarsData>('calendar.listCalendars', { connectionId }).then(data =>
      data.calendars.filter(c => c.canWrite),
    ),
  )
}

/** "From Cal.com: edit its length and rules there", with the team for a Cal.com team's event type. */
function toolTypeSource(connection: CalendarConnection, team?: string) {
  const provider = PROVIDER_LABEL[connection.provider]
  return team
    ? i18n().t('settings.calendar.toolTypes.fromTeam', { provider, team })
    : i18n().t('settings.calendar.toolTypes.from', { provider })
}

/** A refused add in the app's words when the server says why by its code, else as the server said it. */
function addRefusal(e: unknown): string {
  return (e as { code?: string }).code === BOOKING_MODE_REFUSED
    ? i18n().t('settings.calendar.mode.refused')
    : (e as Error).message
}

// ---------------------------------------------------------------------------------------------------------------
// The summary in plain words

function Summary({
  name,
  tool,
  types,
  eventTypes,
  calendars,
  attention,
  onShowAccounts,
}: {
  name: string
  /** The scheduling tool account the assistant books with; none: its own calendars. */
  tool?: CalendarConnection
  types: AppointmentType[]
  eventTypes: AssistantCalendar[]
  calendars: AssistantCalendar[]
  attention: CalendarConnection[]
  onShowAccounts: () => void
}) {
  const t = useT()
  const format = useFormat()
  const bookable = [
    ...types.filter(x => x.enabled).map(x => x.name),
    ...eventTypes.filter(e => e.enabled).map(e => e.name),
  ]
  const live = calendars.filter(c => c.enabled)
  const fallback = live.find(c => c.is_default) ?? eventTypes.find(e => e.enabled && e.is_default)
  const others = live.some(c => c !== fallback)
  return (
    <SummaryCard
      icon="calendar"
      label={t('settings.calendar.summary.label')}
      needsYou={
        attention.length > 0
          ? {
              badge: t('settings.calendar.summary.needsYou'),
              text: (
                <T
                  k="settings.calendar.summary.lostAccess"
                  values={{
                    accounts: format.list([...new Set(attention.map(a => PROVIDER_LABEL[a.provider]))]),
                    link: chunks => <LinkButton onClick={onShowAccounts}>{chunks}</LinkButton>,
                  }}
                />
              ),
            }
          : null
      }
    >
      {bookable.length ? (
        <T k="settings.calendar.summary.books" values={{ name, types: boldList(bookable) }} />
      ) : (
        t('settings.calendar.summary.nothing', { name })
      )}{' '}
      {fallback ? (
        fallback.duration_min === null ? (
          <T
            k="settings.calendar.summary.defaultCalendar"
            values={{ calendar: fallback.name, others: others ? 'some' : 'none', b: bold }}
          />
        ) : (
          <T k="settings.calendar.summary.defaultType" values={{ name, type: fallback.name, b: bold }} />
        )
      ) : live.length || tool ? null : (
        t('settings.calendar.summary.noCalendar')
      )}
      {tool && <> {t('settings.calendar.summary.tool', { tool: PROVIDER_LABEL[tool.provider] })}</>}
    </SummaryCard>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces of the two steps

function StepCard({
  id,
  step,
  title,
  description,
  help,
  actions,
  children,
}: {
  id: string
  step: number
  title: string
  description: string
  help?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const format = useFormat()
  return (
    <Card
      id={id}
      className="st-sec cal-step"
      title={
        <>
          <span className="cal-step-no" aria-hidden="true">
            {format.number(step)}
          </span>
          {title}
        </>
      }
      description={description}
      help={help}
      actions={actions}
    >
      {children}
    </Card>
  )
}

/** "When  the caller needs a repair visit": the condition as a quiet sentence under a row. */
function WhenLine({ text, empty }: { text: string; empty: string }) {
  const t = useT()
  return (
    <p className="cal-when">
      <span className="cal-when-lead">{t('settings.calendar.when.lead')}</span>
      {text ? <span>{text}</span> : <span className="cal-when-empty">{empty}</span>}
    </p>
  )
}

/**
 * The "when" of a calendar or an event type, and whether it is the default (a calendar; an event type only while the
 * assistant has no calendar of its own). An event type's name, length and rules stay in its tool.
 */
function WhenDialog({
  calendar,
  connection,
  kind,
  offerDefault,
  onClose,
}: {
  calendar: AssistantCalendar
  connection?: CalendarConnection
  kind: 'calendar' | 'type'
  offerDefault: boolean
  onClose: () => void
}) {
  const t = useT()
  const run = useRun()
  const [text, setText] = useState(calendar.instruction)
  const [makeDefault, setMakeDefault] = useState(calendar.is_default)
  const provider = connection ? PROVIDER_LABEL[connection.provider] : ''
  function save(e?: FormEvent) {
    e?.preventDefault()
    const next = text.trim()
    if (next !== calendar.instruction)
      void run('assistantCalendar.update', { assistantCalendarId: calendar.id, instruction: next })
    if (makeDefault && !calendar.is_default)
      void run('assistantCalendar.setDefault', { assistantCalendarId: calendar.id })
    onClose()
  }
  return (
    <Dialog
      title={calendar.name}
      description={
        kind === 'type'
          ? t('settings.calendar.whenDialog.type', {
              provider,
              duration: calendar.duration_min ? durationLabel(calendar.duration_min) : '',
            })
          : t('settings.calendar.whenDialog.calendar', { provider })
      }
      icon={connection && <SignInMark method={accountMark(connection)} />}
      size="sm"
      onClose={onClose}
      onSubmit={save}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button type="submit" variant="primary" title={t('common.action.saveWithKey', { key: '⌘S' })}>
            {t('common.action.save')}
          </Button>
        </>
      }
    >
      <Field
        id="cal-when-input"
        label={kind === 'type' ? t('settings.calendar.condition.type') : t('settings.calendar.condition.calendar')}
        tip={t('settings.calendar.type.conditionTip')}
      >
        <Input
          id="cal-when-input"
          value={text}
          maxLength={CONDITION_MAX}
          placeholder={
            calendar.is_default
              ? t('settings.calendar.condition.defaultExample')
              : kind === 'type'
                ? t('settings.calendar.condition.typeExample')
                : t('settings.calendar.condition.calendarExample')
          }
          onChange={e => setText(e.target.value)}
        />
      </Field>
      {offerDefault && (
        <Checkbox checked={makeDefault} disabled={calendar.is_default} onChange={setMakeDefault}>
          {t('settings.calendar.whenDialog.default')}
        </Checkbox>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Step 1: what callers can book

function OwnTypeRow({ type, canEdit, onEdit }: { type: AppointmentType; canEdit: boolean; onEdit: () => void }) {
  const t = useT()
  const run = useRun()
  return (
    <ListRow
      off={!type.enabled}
      className="cal-row"
      lead={
        <span className="cal-own-mark" aria-hidden="true">
          <Icon name="calendar" size={13} />
        </span>
      }
      title={type.name}
      sub={[requiredLabel(type), rulesLabel(type)].filter(Boolean).join(' · ')}
      aside={durationLabel(type.duration_min)}
      actions={
        <>
          <Switch
            label={t('settings.calendar.offer', { name: type.name })}
            on={type.enabled}
            disabled={!canEdit}
            onChange={on =>
              void run('appointmentType.upsert', {
                appointmentTypeId: type.id,
                name: type.name,
                durationMin: type.duration_min,
                enabled: on,
              })
            }
          />
          {canEdit && <EditButton name={type.name} onClick={onEdit} />}
        </>
      }
      below={<WhenLine text={type.instruction} empty={t('settings.calendar.when.byName')} />}
    />
  )
}

/**
 * An event type of a Cal.com or Calendly account: added (on or off, its "when"), or only listed by the tool (off;
 * switching it on adds it with assistantCalendar.add). Its name, length and rules are edited in the tool.
 */
function EventTypeRow({
  added,
  listed,
  connection,
  assistantId,
  canEdit,
  toast,
  onEdit,
}: {
  added?: AssistantCalendar
  listed?: Listed
  connection?: CalendarConnection
  assistantId: string
  canEdit: boolean
  toast: (text: string) => void
  onEdit: (calendar: AssistantCalendar) => void
}) {
  const t = useT()
  const run = useRun()
  const write = useWriteAction()
  const [adding, setAdding] = useState(false)
  const name = added?.name ?? listed?.name ?? ''
  const minutes = added?.duration_min ?? listed?.durationMin ?? null
  const on = added ? added.enabled : adding
  async function toggle(next: boolean) {
    if (added) return void run('assistantCalendar.update', { assistantCalendarId: added.id, enabled: next })
    if (!next || !connection || !listed) return
    setAdding(true)
    try {
      await write('assistantCalendar.add', { assistantId, connectionId: connection.id, externalId: listed.id })
    } catch (e) {
      toast(addRefusal(e))
      setAdding(false)
    }
  }
  const provider = connection ? PROVIDER_LABEL[connection.provider] : ''
  return (
    <ListRow
      off={!on}
      className="cal-row"
      lead={connection && <SignInMark method={accountMark(connection)} />}
      title={
        <>
          <span className="k-row-text">{name}</span>
          {added?.is_default && <Badge tone="outline">{t('settings.calendar.default')}</Badge>}
          {connection && (
            <span className="cal-source" title={toolTypeSource(connection, listed?.group)}>
              {listed?.group ? `${provider} · ${listed.group}` : provider}
            </span>
          )}
        </>
      }
      aside={minutes ? durationLabel(minutes) : undefined}
      actions={
        <>
          <Switch
            label={t('settings.calendar.offer', { name })}
            on={on}
            disabled={!canEdit || adding || (!added && connection?.status !== 'connected')}
            onChange={next => void toggle(next)}
          />
          {canEdit &&
            (added ? (
              <EditButton name={name} onClick={() => onEdit(added)} />
            ) : (
              <span className="cal-edit-gap" aria-hidden="true" />
            ))}
        </>
      }
      below={added && <WhenLine text={added.instruction} empty={t('settings.calendar.when.byName')} />}
    />
  )
}

/** All event types of one connected Cal.com or Calendly account: the added ones and the others the tool lists. */
function ToolTypes({
  connection,
  added,
  ...rest
}: {
  connection: CalendarConnection
  added: AssistantCalendar[]
  assistantId: string
  canEdit: boolean
  toast: (text: string) => void
  onEdit: (calendar: AssistantCalendar) => void
}) {
  const t = useT()
  const listed = useCalendarList(connection.id)
  const rows = toolTypeRows(added, listed.data ?? null)
  const what = t('settings.calendar.what.title')
  if (!rows.length) {
    // Nothing added yet: the list of the tool is all there is, so show its loading, its error or that it is empty.
    return (
      <Loading
        what={what}
        loading={!listed.data && !listed.error}
        error={listed.data ? null : listed.error}
        onRetry={() => void listed.reload()}
        skeleton={<SkeletonList rows={2} action />}
      >
        <ListEmpty>{t('settings.calendar.noEventTypes', { tool: PROVIDER_LABEL[connection.provider] })}</ListEmpty>
      </Loading>
    )
  }
  return (
    <List label={what} className="cal-list">
      {rows.map(row => (
        <EventTypeRow
          key={row.added?.id ?? `off-${row.listed?.id}`}
          added={row.added}
          listed={row.listed}
          connection={connection}
          {...rest}
        />
      ))}
    </List>
  )
}

function StepWhat({
  assistantId,
  name,
  canEdit,
  toast,
  types,
  connections,
  tool,
  eventTypes,
}: {
  assistantId: string
  name: string
  canEdit: boolean
  toast: (text: string) => void
  types: AppointmentType[]
  connections: CalendarConnection[]
  /** The scheduling tool account the assistant books with: only its event types. None: the own types. */
  tool?: CalendarConnection
  eventTypes: AssistantCalendar[]
}) {
  const t = useT()
  const [editing, setEditing] = useState<AppointmentType | 'new' | null>(null)
  const [editingEvent, setEditingEvent] = useState<AssistantCalendar | null>(null)
  const rowProps = { assistantId, canEdit, toast, onEdit: setEditingEvent }
  const toolName = tool ? PROVIDER_LABEL[tool.provider] : ''
  return (
    <StepCard
      id="as-cal-types"
      step={1}
      title={t('settings.calendar.what.title')}
      description={
        tool
          ? t('settings.calendar.what.toolDescription', { name, tool: toolName })
          : t('settings.calendar.what.description', { name })
      }
      actions={
        canEdit &&
        !tool && (
          <Button size="sm" icon="plus" title={t('settings.calendar.type.newTitle')} onClick={() => setEditing('new')}>
            {t('settings.calendar.addType')}
          </Button>
        )
      }
    >
      {tool ? (
        tool.status === 'connected' ? (
          <ToolTypes connection={tool} added={eventTypes} {...rowProps} />
        ) : (
          // An account that has to be connected again: its added event types as they are.
          <List label={t('settings.calendar.what.title')} className="cal-list">
            {eventTypes.map(e => (
              <EventTypeRow key={e.id} added={e} connection={tool} {...rowProps} />
            ))}
          </List>
        )
      ) : types.length ? (
        <List label={t('settings.calendar.what.title')} className="cal-list">
          {types.map(type => (
            <OwnTypeRow key={type.id} type={type} canEdit={canEdit} onEdit={() => setEditing(type)} />
          ))}
        </List>
      ) : (
        <ListEmpty>{t('settings.calendar.noType')}</ListEmpty>
      )}
      {tool && <p className="cal-step-note">{t('settings.calendar.where.toolNote', { name, tool: toolName })}</p>}
      {editing && (
        <AppointmentTypeDialog
          type={editing === 'new' ? undefined : editing}
          assistantName={name}
          onClose={() => setEditing(null)}
        />
      )}
      {editingEvent && (
        <WhenDialog
          calendar={editingEvent}
          connection={connections.find(c => c.id === editingEvent.connection_id)}
          kind="type"
          offerDefault
          onClose={() => setEditingEvent(null)}
        />
      )}
    </StepCard>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: where the assistant puts them

function CalendarRow({
  calendar,
  connection,
  canEdit,
  onEdit,
}: {
  calendar: AssistantCalendar
  connection?: CalendarConnection
  canEdit: boolean
  onEdit: () => void
}) {
  const t = useT()
  const run = useRun()
  return (
    <ListRow
      off={!calendar.enabled}
      className="cal-row"
      lead={connection && <SignInMark method={accountMark(connection)} />}
      title={
        <>
          <span className="k-row-text">{calendar.name}</span>
          {calendar.is_default && <Badge tone="outline">{t('settings.calendar.default')}</Badge>}
        </>
      }
      actions={
        <>
          <Switch
            label={t('settings.calendar.bookInto', { name: calendar.name })}
            on={calendar.enabled}
            disabled={!canEdit}
            onChange={on => void run('assistantCalendar.update', { assistantCalendarId: calendar.id, enabled: on })}
          />
          {canEdit && <EditButton name={calendar.name} onClick={onEdit} />}
        </>
      }
      below={
        <WhenLine
          text={calendar.instruction}
          empty={
            calendar.is_default ? t('settings.calendar.condition.defaultExample') : t('settings.calendar.when.notSet')
          }
        />
      }
    />
  )
}

function StepWhere({
  name,
  canEdit,
  calendars,
  connections,
  onPick,
}: {
  name: string
  canEdit: boolean
  calendars: AssistantCalendar[]
  connections: CalendarConnection[]
  onPick: (connectionId: string) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState<AssistantCalendar | null>(null)
  const sources = connections.filter(c => !isSchedulingTool(c.provider) && c.status === 'connected')
  const chooseTip = t('settings.calendar.chooseTip', { name })
  return (
    <StepCard
      id="as-cal-calendars"
      step={2}
      title={t('settings.calendar.where.activeTitle')}
      description={t('settings.calendar.where.description')}
      help={`${t('settings.calendar.calendarsHelp', { name })} ${t('settings.calendar.maxWait', { name, seconds: TOOL_MAX_WAIT_MS / 1000 })}`}
      actions={
        canEdit &&
        sources.length > 0 &&
        (sources.length === 1 ? (
          <Button size="sm" icon="checks" title={chooseTip} onClick={() => onPick(sources[0]!.id)}>
            {t('settings.calendar.choose')}
          </Button>
        ) : (
          <MenuButton
            label={t('settings.calendar.choose')}
            icon="checks"
            variant="secondary"
            title={chooseTip}
            items={sources.map(c => ({
              id: c.id,
              label: `${PROVIDER_LABEL[c.provider]} · ${c.account_email}`,
              lead: <SignInMark method={accountMark(c)} />,
              onSelect: () => onPick(c.id),
            }))}
          />
        ))
      }
    >
      {calendars.length ? (
        <List label={t('settings.calendar.calendars')} className="cal-list">
          {calendars.map(c => (
            <CalendarRow
              key={c.id}
              calendar={c}
              connection={connections.find(a => a.id === c.connection_id)}
              canEdit={canEdit}
              onEdit={() => setEditing(c)}
            />
          ))}
        </List>
      ) : (
        <ListEmpty>
          {sources.length ? t('settings.calendar.noCalendar', { name }) : t('settings.calendar.where.noSource')}
        </ListEmpty>
      )}
      {editing && (
        <WhenDialog
          calendar={editing}
          connection={connections.find(c => c.id === editing.connection_id)}
          kind="calendar"
          offerDefault
          onClose={() => setEditing(null)}
        />
      )}
    </StepCard>
  )
}

/**
 * The calendars of one account as checkboxes: the ones the assistant books into are ticked. Saving adds the newly
 * ticked ones and removes the unticked ones (assistantCalendar.add / .remove, one at a time). The one place to change
 * the choice, also later. (A Cal.com or Calendly account has no picker: its event types are switched on in step 1.)
 */
function CalendarPicker({
  assistant,
  connection,
  onClose,
  toast,
}: {
  assistant: Assistant
  connection: CalendarConnection
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const write = useWriteAction()
  const listed = useCalendarList(connection.id)
  const options = listed.data ?? null
  const current = useRows('assistant_calendars').filter(
    c => c.assistant_id === assistant.id && c.connection_id === connection.id,
  )
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const shown = picked ?? new Set(current.map(c => c.external_id))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const toggle = (id: string, on: boolean) =>
    setPicked(() => {
      const next = new Set(shown)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  async function save(e?: FormEvent) {
    e?.preventDefault()
    if (saving || !options) return
    // In the order the account lists them, so the first one added (the default when there is none yet) is the first one.
    const inOrder = new Set(options.map(c => c.id).filter(id => shown.has(id)))
    const { add, remove } = pickChanges(current, inOrder, new Set(options.map(c => c.id)))
    if (!add.length && !remove.length) return onClose()
    setSaving(true)
    setSaveError(null)
    try {
      for (const externalId of add)
        await write('assistantCalendar.add', { assistantId: assistant.id, connectionId: connection.id, externalId })
      for (const assistantCalendarId of remove) await write('assistantCalendar.remove', { assistantCalendarId })
      toast(t('settings.calendar.picker.saved'))
      onClose()
    } catch (err) {
      setSaveError(addRefusal(err))
      setSaving(false)
    }
  }
  const what = t('settings.calendar.calendars')
  return (
    <Dialog
      title={t('settings.calendar.picker.title', { email: connection.account_email })}
      description={t('settings.calendar.picker.description', { name: assistant.name })}
      icon={<SignInMark method={accountMark(connection)} />}
      onClose={onClose}
      onSubmit={save}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={saving}
            disabled={!options}
            title={t('common.action.saveWithKey', { key: '⌘S' })}
          >
            {t('common.action.save')}
          </Button>
        </>
      }
    >
      {saveError && <p className="k-field-msg">{saveError}</p>}
      <Loading
        what={what}
        loading={!options}
        error={options ? null : listed.error}
        onRetry={() => void listed.reload()}
        skeleton={<SkeletonList rows={3} sub={false} action />}
      >
        <ul className="k-list cal-pick" aria-label={what}>
          {(options ?? []).map(c => (
            <li key={c.id} className="k-row">
              <Checkbox checked={shown.has(c.id)} disabled={saving} onChange={on => toggle(c.id, on)}>
                <span className="cal-pick-name">{c.name}</span>
                {c.primary && <span className="cal-pick-len">{t('settings.calendar.main')}</span>}
              </Checkbox>
            </li>
          ))}
        </ul>
        {options?.length === 0 && <ListEmpty>{t('settings.calendar.noWritable')}</ListEmpty>}
      </Loading>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Calendar accounts: one place, folded away

/** A connected account as a row: provider mark, address, and whether it still works. */
function AccountRow({ connection, children }: { connection: CalendarConnection; children?: ReactNode }) {
  const t = useT()
  const c = connection
  return (
    <ListRow
      lead={<SignInMark method={accountMark(c)} />}
      title={c.account_email}
      sub={c.status === 'needs_reconnect' ? (c.last_error ?? t('settings.calendar.accessWithdrawn')) : undefined}
      aside={
        c.status === 'connected' ? (
          <Badge tone="ok">
            <StatusMark state="works" label={t('settings.calendar.connectedBadge')} />
            {t('settings.calendar.connectedBadge')}
          </Badge>
        ) : (
          <Badge tone="danger">
            <StatusMark state="failing" label={t('settings.calendar.withdrawnMark')} />
            {t('settings.calendar.connectAgain')}
          </Badge>
        )
      }
      actions={children}
    />
  )
}

/** "Add account": one button, then the choice of provider (only those this install offers). */
function AddAccount({ providers, busy, connect }: Connector) {
  const t = useT()
  if (!providers?.length) return null
  return (
    <MenuButton
      label={
        busy ? t('settings.calendar.opening', { provider: PROVIDER_LABEL[busy] }) : t('settings.calendar.addAccount')
      }
      icon="plus"
      variant="secondary"
      title={t('settings.calendar.addAccountTip')}
      disabled={busy !== null}
      items={providers.map(p => ({
        id: p,
        label: PROVIDER_LABEL[p],
        lead: <SignInMark method={connectMark(p)} />,
        onSelect: () => void connect(p),
      }))}
    />
  )
}

function Accounts({
  connections,
  canEdit,
  connector,
  toast,
  open,
  onToggle,
}: {
  connections: CalendarConnection[]
  canEdit: boolean
  connector: Connector
  toast: (text: string) => void
  open: boolean
  onToggle: (open: boolean) => void
}) {
  const t = useT()
  const format = useFormat()
  const write = useWriteAction()
  const [busy, setBusy] = useState<string | null>(null)
  const attention = connections.filter(c => c.status !== 'connected')
  // No "are you sure?": connecting again is a click away, and booked events stay.
  async function disconnect(c: CalendarConnection) {
    setBusy(c.id)
    try {
      const { note } = await write<DisconnectData>('calendar.disconnect', { connectionId: c.id })
      toast(note ?? t('settings.calendar.disconnected'))
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <details
      id="as-cal-accounts"
      className="cal-accounts"
      open={open}
      onToggle={e => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary title={open ? t('settings.calendar.accountsHide') : t('settings.calendar.accountsShow')}>
        <Icon name="down" size={14} className="cal-accounts-chevron" />
        <span className="cal-accounts-title">{t('settings.calendar.accounts')}</span>
        <span className="cal-accounts-marks" aria-hidden="true">
          {connections.map(c => (
            <SignInMark key={c.id} method={accountMark(c)} />
          ))}
        </span>
        <span className="cal-accounts-count">{format.number(connections.length)}</span>
        {attention.length > 0 && (
          <Badge tone="danger">{t('settings.calendar.accountsToReconnect', { count: attention.length })}</Badge>
        )}
      </summary>
      <div className="cal-accounts-body">
        <List label={t('settings.calendar.accounts')}>
          {connections.map(c => (
            <AccountRow key={c.id} connection={c}>
              {canEdit && (
                <MenuButton
                  title={t('settings.calendar.actionsFor', { name: c.account_email })}
                  disabled={busy === c.id || connector.busy !== null}
                  items={[
                    ...(c.status === 'needs_reconnect'
                      ? [
                          {
                            id: 'reconnect',
                            label: t('settings.calendar.connectAgain'),
                            onSelect: () => void connector.connect(c.provider),
                          },
                        ]
                      : []),
                    {
                      id: 'disconnect',
                      label: t('settings.calendar.disconnect'),
                      danger: true,
                      onSelect: () => void disconnect(c),
                    },
                  ]}
                />
              )}
            </AccountRow>
          ))}
        </List>
        {canEdit && (
          <div className="cal-accounts-foot">
            <span>{t('settings.calendar.accountsNote')}</span>
            <AddAccount {...connector} />
          </div>
        )}
      </div>
    </details>
  )
}

/** No account yet: a friendly start with one button per provider. */
function Start({ name, canEdit, connector }: { name: string; canEdit: boolean; connector: Connector }) {
  const t = useT()
  return (
    <section className="cal-start" aria-labelledby="cal-start-h">
      <span className="cal-start-mark" aria-hidden="true">
        <Icon name="calendar" size={22} />
      </span>
      <h2 id="cal-start-h">{t('settings.calendar.start.title', { name })}</h2>
      <p>{t('settings.calendar.start.body', { name })}</p>
      {connector.providers?.length === 0 ? (
        <MissingProviderNote kind="calendar" />
      ) : (
        canEdit && (
          <div className="cal-connect cal-start-buttons">
            {(connector.providers ?? []).map(p => (
              <Button
                key={p}
                disabled={connector.busy !== null}
                onClick={() => void connector.connect(p)}
                title={t('settings.calendar.connectTip', { provider: PROVIDER_LABEL[p] })}
              >
                <SignInMark method={connectMark(p)} />
                {connector.busy === p
                  ? t('settings.calendar.opening', { provider: PROVIDER_LABEL[p] })
                  : t('settings.calendar.connect', { provider: PROVIDER_LABEL[p] })}
              </Button>
            ))}
          </div>
        )
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// How the assistant books: its own calendars, or one scheduling tool account

type Switching = { to: string | null; leaving: AssistantCalendar[] }

function ModeChoice({
  name,
  canEdit,
  tools,
  current,
  onChoose,
}: {
  name: string
  canEdit: boolean
  tools: CalendarConnection[]
  current: string | null
  onChoose: (toolConnectionId: string | null) => void
}) {
  const t = useT()
  return (
    <Card
      id="as-cal-mode"
      className="st-sec cal-mode"
      title={t('settings.calendar.mode.title', { name })}
      description={t('settings.calendar.mode.description')}
    >
      <div className="k-radios" role="radiogroup" aria-label={t('settings.calendar.mode.title', { name })}>
        <RadioCard
          name="cal-mode"
          checked={current === null}
          disabled={!canEdit}
          onPick={() => onChoose(null)}
          title={t('settings.calendar.mode.calendars')}
          description={t('settings.calendar.mode.calendarsHelp')}
        />
        {tools.map(c => (
          <RadioCard
            key={c.id}
            name="cal-mode"
            checked={current === c.id}
            disabled={!canEdit}
            onPick={() => onChoose(c.id)}
            title={
              <span className="cal-mode-tool">
                <SignInMark method={accountMark(c)} />
                {PROVIDER_LABEL[c.provider]}
              </span>
            }
            description={t('settings.calendar.mode.toolHelp', { email: c.account_email })}
          />
        ))}
      </div>
    </Card>
  )
}

/** Confirms a switch that takes calendars or event types off the assistant, then takes them off one at a time. */
function SwitchModeDialog({
  name,
  switching,
  tool,
  onDone,
  onClose,
  toast,
}: {
  name: string
  switching: Switching
  tool?: CalendarConnection
  onDone: () => void
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const write = useWriteAction()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Nothing to type here: the focus starts on Switch (after the dialog's own focus trap), so Enter switches, Esc cancels.
  const switchButton = useRef<HTMLButtonElement>(null)
  useEffect(() => switchButton.current?.focus(), [])
  async function confirm(e?: FormEvent) {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    onDone()
    try {
      for (const c of switching.leaving) await write('assistantCalendar.remove', { assistantCalendarId: c.id })
      toast(
        tool
          ? t('settings.calendar.mode.switched', { name, tool: PROVIDER_LABEL[tool.provider] })
          : t('settings.calendar.mode.switchedCalendars', { name }),
      )
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={
        tool
          ? t('settings.calendar.mode.toTool', { tool: PROVIDER_LABEL[tool.provider] })
          : t('settings.calendar.mode.toCalendars')
      }
      icon={tool && <SignInMark method={accountMark(tool)} />}
      size="sm"
      onClose={onClose}
      onSubmit={confirm}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            ref={switchButton}
            title={t('settings.calendar.mode.switchTip')}
          >
            {t('settings.calendar.mode.switch')}
          </Button>
        </>
      }
    >
      {error && <p className="k-field-msg">{error}</p>}
      <p>
        <T k="settings.calendar.mode.removes" values={{ name, list: boldList(switching.leaving.map(c => c.name)) }} />
      </p>
      {tool && (
        <p className="cal-mode-note">
          {t('settings.calendar.mode.ownTypesNote', { name, tool: PROVIDER_LABEL[tool.provider] })}
        </p>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------------------------

export function CalendarSettings({ assistant, canEdit, toast }: Props) {
  const t = useT()
  const returned = useConnectResult(toast)
  const ready = useCalendarsReady()
  const typesLoad = useLoadState('appointment_types')
  const connections = useRows('calendar_connections').sort(byCreated)
  const byId = new Map(connections.map(c => [c.id, c]))
  const all = calendarsOf(useRows('assistant_calendars'), assistant.id)
  // How the assistant books, as the server decides it (bookingMode): by its rows; without rows, as chosen here last.
  const [chosen, setChosen] = useState<string | null>(null)
  const toolId = all.length ? bookingMode(all).toolConnectionId : chosen
  const mode = { toolConnectionId: toolId }
  const tool = toolId ? byId.get(toolId) : undefined
  // Rows from before the one-mode rule that do not fit it are not shown (booking leaves them out too).
  const calendars = toolId ? [] : all.filter(c => fitsBookingMode(mode, c))
  const eventTypes = toolId ? all.filter(c => fitsBookingMode(mode, c)).sort(byCreated) : []
  const tools = connections.filter(c => isSchedulingTool(c.provider))
  const [switching, setSwitching] = useState<Switching | null>(null)
  const choose = (to: string | null) => {
    if (to === toolId) return
    const leaving = all.filter(c => !fitsBookingMode({ toolConnectionId: to }, c))
    if (leaving.length) setSwitching({ to, leaving })
    else setChosen(to)
  }
  const types = useRows('appointment_types').sort(byCreated)
  const attention = connections.filter(c => c.status !== 'connected')

  /** The account whose picker is open: the one just connected (back from its consent page, or from a key form). */
  const [picking, setPicking] = useState<string | null>(canEdit ? returned : null)
  const pick = (connectionId: string) => {
    // A scheduling tool has no picker: its event types are listed in step 1 with a switch each.
    const c = connections.find(x => x.id === connectionId)
    if (c && isSchedulingTool(c.provider)) return
    setPicking(canEdit ? connectionId : null)
  }
  // The rights can load after the first render: open the picker of the account just connected then.
  useEffect(() => {
    if (canEdit && returned !== null) setPicking(p => p ?? returned)
  }, [canEdit, returned])
  const connector = useConnect(assistant.id, toast, pick)
  const pickable = connections.filter(c => c.status === 'connected' && !isSchedulingTool(c.provider))
  // '' when the callback did not name the account: the calendar account connected last.
  // An assistant that books with a scheduling tool has no calendars of its own to pick.
  const target =
    picking === null || !ready || toolId ? undefined : picking ? pickable.find(c => c.id === picking) : pickable.at(-1)
  // An account that is not (or no longer) connected: forget it, so its picker does not open later by surprise.
  useEffect(() => {
    if (ready && picking !== null && !target) setPicking(null)
  }, [ready, picking, target])

  const [accountsOpen, setAccountsOpen] = useState(false)
  const showAccounts = () => {
    setAccountsOpen(true)
    requestAnimationFrame(() => document.getElementById('as-cal-accounts')?.scrollIntoView({ behavior: 'smooth' }))
  }

  return (
    <div className="cal-page">
      <Loading
        what={t('settings.assistant.section.booking.label')}
        loading={!ready || typesLoad !== 'ready'}
        skeleton={<SkeletonList rows={4} action />}
      >
        {connections.length === 0 ? (
          <Start name={assistant.name} canEdit={canEdit} connector={connector} />
        ) : (
          <Summary
            name={assistant.name}
            tool={tool}
            // With a scheduling tool the own types are not offered: only its event types.
            types={tool ? [] : types}
            eventTypes={eventTypes}
            calendars={calendars}
            attention={attention}
            onShowAccounts={showAccounts}
          />
        )}
        {tools.length > 0 && (
          <ModeChoice name={assistant.name} canEdit={canEdit} tools={tools} current={toolId} onChoose={choose} />
        )}
        <StepWhat
          assistantId={assistant.id}
          name={assistant.name}
          canEdit={canEdit}
          toast={toast}
          types={types}
          connections={connections}
          tool={tool}
          eventTypes={eventTypes}
        />
        {connections.length > 0 && (
          <>
            {!tool && (
              <StepWhere
                name={assistant.name}
                canEdit={canEdit}
                calendars={calendars}
                connections={connections}
                onPick={pick}
              />
            )}
            <Accounts
              connections={connections}
              canEdit={canEdit}
              connector={connector}
              toast={toast}
              open={accountsOpen}
              onToggle={setAccountsOpen}
            />
          </>
        )}
      </Loading>
      {connector.dialog}
      {switching && (
        <SwitchModeDialog
          name={assistant.name}
          switching={switching}
          tool={switching.to ? byId.get(switching.to) : undefined}
          onDone={() => setChosen(switching.to)}
          onClose={() => setSwitching(null)}
          toast={toast}
        />
      )}
      {target && (
        <CalendarPicker
          key={target.id}
          assistant={assistant}
          connection={target}
          onClose={() => setPicking(null)}
          toast={toast}
        />
      )}
    </div>
  )
}
