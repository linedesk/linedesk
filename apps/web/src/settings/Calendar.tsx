// Settings › Assistant › Calendar: connected Google, Microsoft, CalDAV (iCloud), Cal.com and Calendly accounts, the
// calendars this assistant books into (on or off, a note on when to use each, one default; a Cal.com or Calendly
// account is one entry with the event types picked under it), and the appointment types it offers. Changes apply at once (not part of the page's Save): connecting leaves the page
// for the provider's consent screen anyway (or checks a CalDAV login in a dialog), and the rest are small,
// single changes through the outbox.
import type { ConnectStartData, DisconnectData, ListCalendarsData } from '@linedesk/actions'
import { CONDITION_MAX } from '@linedesk/actions'
import type { AppointmentType, Assistant, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { useRows, useRun } from '../store.tsx'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { DeleteButton, EditButton, List, ListEmpty, ListRow, MenuButton } from '../ui/list.tsx'
import { Loading, Skeleton, SkeletonList, useLoadState } from '../ui/LoadStates.tsx'
import { useQuery } from '../cachedQuery.ts'
import { MissingProviderNote } from './MissingProviderNote.tsx'
import {
  accountMark,
  BOOK_WHEN,
  BOOKING_FIELDS,
  type BookingFieldId,
  type BookWhen,
  BUFFERS,
  bookWhenLabel,
  bufferLabel,
  CONNECT_RETURN_KEY,
  calendarEntries,
  calendarsOf,
  connectMark,
  connectResult,
  DURATIONS,
  durationLabel,
  fieldLabel,
  groupByTeam,
  isPasswordProvider,
  isSchedulingTool,
  type KeyProviderId,
  PROVIDER_LABEL,
  pickChanges,
  type ProviderId,
  requiredLabel,
  rulesLabel,
  toolTypeRows,
  typeFields,
} from './calendarModel.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { KeyConnectDialog } from './KeyConnect.tsx'
import { Field, Section } from './fields.tsx'
import { useCalendarConnectWays } from './calendar-providers.ts'
import { callAction, useWriteAction } from './settings-api.ts'
import './calendar.css'

type Props = { assistant: Assistant; canEdit: boolean; toast: (text: string) => void }

/** What the OAuth callback writes: the page reads them again on return before showing them. */
const CONNECT_TABLES = ['calendar_connections', 'assistant_calendars'] as const

/** Whether the calendar accounts and calendars can be shown yet (loaded, and not from before a connect). */
export function useCalendarsReady(): boolean {
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

/** One button per calendar provider this install offers. Used in onboarding. */
export function ConnectButtons({ assistantId, toast }: { assistantId: string; toast: (text: string) => void }) {
  const t = useT()
  const { providers, busy, connect, dialog } = useConnect(assistantId, toast)
  if (!providers)
    return (
      <Loading what={t('settings.calendar.loadProviders')} loading skeleton={<Skeleton width={190} height={32} />} />
    )
  if (!providers.length) return <MissingProviderNote kind="calendar" />
  return (
    <div className="cal-connect">
      {providers.map(p => (
        <Button
          key={p}
          disabled={busy !== null}
          onClick={() => connect(p)}
          title={t('settings.calendar.connectTip', { provider: PROVIDER_LABEL[p] })}
        >
          <SignInMark method={connectMark(p)} />
          {busy === p
            ? t('settings.calendar.opening', { provider: PROVIDER_LABEL[p] })
            : t('settings.calendar.connect', { provider: PROVIDER_LABEL[p] })}
        </Button>
      ))}
      {dialog}
    </div>
  )
}

/** A connected account as a row: provider mark, address, and whether it still works. */
export function AccountRow({ connection, children }: { connection: CalendarConnection; children?: ReactNode }) {
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
function AddAccount({ providers, busy, connect }: ReturnType<typeof useConnect>) {
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
  assistant,
  canEdit,
  toast,
  onConnected,
  onPick,
}: Props & { onConnected: (connectionId: string) => void; onPick: (connectionId: string) => void }) {
  const t = useT()
  const write = useWriteAction()
  const connections = useRows('calendar_connections').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const accountsLoad = useLoadState('calendar_connections')
  const ready = accountsLoad === 'ready'
  const connector = useConnect(assistant.id, toast, onConnected)
  const [busy, setBusy] = useState<string | null>(null)

  // No "are you sure?": connecting again is a click away, and booked events stay.
  async function disconnect(connection: CalendarConnection) {
    setBusy(connection.id)
    try {
      const { note } = await write<DisconnectData>('calendar.disconnect', { connectionId: connection.id })
      toast(note ?? t('settings.calendar.disconnected'))
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const rowMenu = (c: CalendarConnection) => (
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
  )

  return (
    <Section
      id="as-cal-accounts"
      title={t('settings.calendar.accounts')}
      actions={canEdit && ready && <AddAccount {...connector} />}
    >
      <Loading
        what={t('settings.calendar.accounts')}
        loading={!ready}
        error={accountsLoad === 'slow'}
        skeleton={<SkeletonList rows={1} lead={20} action />}
      >
        {connections.length > 0 ? (
          <List label={t('settings.calendar.accounts')}>
            {connections.map(c => (
              <AccountRow key={c.id} connection={c}>
                {canEdit && (
                  <>
                    <PickButton connection={c} onPick={() => onPick(c.id)} />
                    {rowMenu(c)}
                  </>
                )}
              </AccountRow>
            ))}
          </List>
        ) : connector.providers?.length === 0 ? (
          <MissingProviderNote kind="calendar" />
        ) : (
          <ListEmpty>{t('settings.calendar.noAccount', { name: assistant.name })}</ListEmpty>
        )}
      </Loading>
      {connector.dialog}
    </Section>
  )
}

/**
 * The condition for when the assistant uses a calendar or a type, read as one sentence: "Use this
 * calendar when … the caller needs an emergency visit". Saved when the field loses focus (or on
 * Enter), so typing is not a command per key.
 */
function ConditionField({
  what,
  name,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  what: 'calendar' | 'type'
  name: string
  value: string
  placeholder: string
  disabled: boolean
  onSave: (value: string) => void
}) {
  const t = useT()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const save = () => {
    const next = text.trim()
    if (next !== value) onSave(next)
  }
  return (
    <span className="cal-cond">
      <span className="cal-cond-lead" aria-hidden="true">
        {what === 'calendar' ? t('settings.calendar.condition.calendar') : t('settings.calendar.condition.type')}
      </span>
      <Input
        aria-label={t('settings.calendar.condition.label', { name })}
        placeholder={placeholder}
        value={text}
        maxLength={CONDITION_MAX}
        disabled={disabled}
        onChange={e => setText(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          // Enter saves this line (by leaving it), never the page's form around it (the Assistant Save).
          if (e.key !== 'Enter') return
          e.preventDefault()
          e.currentTarget.blur()
        }}
      />
    </span>
  )
}

function CalendarRow({
  calendar,
  account,
  canEdit,
  onRemove,
}: {
  calendar: AssistantCalendar
  account?: CalendarConnection
  canEdit: boolean
  onRemove: () => void
}) {
  const t = useT()
  const run = useRun()
  return (
    <ListRow
      off={!calendar.enabled}
      lead={account && <SignInMark method={accountMark(account)} />}
      title={
        <>
          {calendar.name}
          {calendar.is_default && <Badge tone="outline">{t('settings.calendar.default')}</Badge>}
        </>
      }
      sub={
        calendar.duration_min !== null && account
          ? t('settings.calendar.eventTypeOf', {
              provider: PROVIDER_LABEL[account.provider],
              duration: durationLabel(calendar.duration_min),
              email: account.account_email,
            })
          : account?.account_email
      }
      actions={
        <>
          <Switch
            label={t('settings.calendar.bookInto', { name: calendar.name })}
            on={calendar.enabled}
            disabled={!canEdit}
            onChange={on => void run('assistantCalendar.update', { assistantCalendarId: calendar.id, enabled: on })}
          />
          {canEdit && (
            <MenuButton
              title={t('settings.calendar.actionsFor', { name: calendar.name })}
              items={[
                ...(calendar.is_default
                  ? []
                  : [
                      {
                        id: 'default',
                        label: t('settings.calendar.makeDefault'),
                        onSelect: () => void run('assistantCalendar.setDefault', { assistantCalendarId: calendar.id }),
                      },
                    ]),
                { id: 'remove', label: t('settings.calendar.remove'), danger: true, onSelect: onRemove },
              ]}
            />
          )}
        </>
      }
      below={
        <ConditionField
          what="calendar"
          name={calendar.name}
          value={calendar.instruction}
          placeholder={
            calendar.is_default
              ? t('settings.calendar.condition.defaultExample')
              : t('settings.calendar.condition.calendarExample')
          }
          disabled={!canEdit}
          onSave={instruction =>
            void run('assistantCalendar.update', { assistantCalendarId: calendar.id, instruction })
          }
        />
      }
    />
  )
}

/**
 * A picked event type of a scheduling tool, under its account: on or off, a note on when to use it, one default (like a
 * calendar: an event type is the tool's calendar and its own appointment type at once).
 */
function EventTypeRow({ type, canEdit }: { type: AssistantCalendar; canEdit: boolean }) {
  const t = useT()
  const run = useRun()
  return (
    <ListRow
      off={!type.enabled}
      title={
        <>
          <span className="k-row-text">{type.name}</span>
          {type.is_default && <Badge tone="outline">{t('settings.calendar.default')}</Badge>}
        </>
      }
      aside={type.duration_min !== null ? durationLabel(type.duration_min) : undefined}
      actions={
        <>
          <Switch
            label={t('settings.calendar.bookInto', { name: type.name })}
            on={type.enabled}
            disabled={!canEdit}
            onChange={on => void run('assistantCalendar.update', { assistantCalendarId: type.id, enabled: on })}
          />
          {canEdit && (
            <MenuButton
              title={t('settings.calendar.actionsFor', { name: type.name })}
              items={[
                ...(type.is_default
                  ? []
                  : [
                      {
                        id: 'default',
                        label: t('settings.calendar.makeDefault'),
                        onSelect: () => void run('assistantCalendar.setDefault', { assistantCalendarId: type.id }),
                      },
                    ]),
                {
                  id: 'remove',
                  label: t('settings.calendar.remove'),
                  danger: true,
                  onSelect: () => void run('assistantCalendar.remove', { assistantCalendarId: type.id }),
                },
              ]}
            />
          )}
        </>
      }
      below={
        <ConditionField
          what="type"
          name={type.name}
          value={type.instruction}
          placeholder={
            type.is_default
              ? t('settings.calendar.condition.defaultExample')
              : t('settings.calendar.condition.typeExample')
          }
          disabled={!canEdit}
          onSave={instruction => void run('assistantCalendar.update', { assistantCalendarId: type.id, instruction })}
        />
      }
    />
  )
}

/**
 * A picked event type of a scheduling tool under Appointment types: its tool's mark, length, on or off. Its name,
 * length and rules are edited in the tool, so nothing else here.
 */
function ToolTypeRow({
  type,
  connection,
  team,
  canEdit,
}: {
  type: AssistantCalendar
  connection: CalendarConnection | undefined
  team?: string
  canEdit: boolean
}) {
  const t = useT()
  const run = useRun()
  return (
    <ListRow
      off={!type.enabled}
      lead={connection && <SignInMark method={accountMark(connection)} />}
      title={type.name}
      sub={connection && toolTypeSource(connection, team)}
      aside={type.duration_min !== null ? durationLabel(type.duration_min) : undefined}
      actions={
        <Switch
          label={t('settings.calendar.bookInto', { name: type.name })}
          on={type.enabled}
          disabled={!canEdit}
          onChange={on => void run('assistantCalendar.update', { assistantCalendarId: type.id, enabled: on })}
        />
      }
    />
  )
}

/** "From Cal.com: edit its length and rules there", with the team for a Cal.com team's event type. */
function toolTypeSource(connection: CalendarConnection, team?: string) {
  const provider = PROVIDER_LABEL[connection.provider]
  return team
    ? i18n().t('settings.calendar.toolTypes.fromTeam', { provider, team })
    : i18n().t('settings.calendar.toolTypes.from', { provider })
}

/** An event type of a tool the assistant does not book yet: off; switching it on adds it (assistantCalendar.add). */
function OffToolTypeRow({
  assistant,
  connection,
  type,
  canEdit,
  toast,
}: {
  assistant: Assistant
  connection: CalendarConnection
  type: Listed
  canEdit: boolean
  toast: (text: string) => void
}) {
  const t = useT()
  const write = useWriteAction()
  const [adding, setAdding] = useState(false)
  async function add() {
    setAdding(true)
    try {
      await write('assistantCalendar.add', {
        assistantId: assistant.id,
        connectionId: connection.id,
        externalId: type.id,
      })
    } catch (e) {
      toast((e as Error).message)
      setAdding(false)
    }
  }
  return (
    <ListRow
      off={!adding}
      lead={<SignInMark method={accountMark(connection)} />}
      title={type.name}
      sub={toolTypeSource(connection, type.group)}
      aside={type.durationMin ? durationLabel(type.durationMin) : undefined}
      actions={
        <Switch
          label={t('settings.calendar.bookInto', { name: type.name })}
          on={adding}
          disabled={!canEdit || adding}
          onChange={on => void (on && add())}
        />
      }
    />
  )
}

/** All event types of one connected Cal.com or Calendly account under Appointment types: the added ones on or off. */
function ToolTypes({
  assistant,
  connection,
  added,
  canEdit,
  toast,
}: {
  assistant: Assistant
  connection: CalendarConnection
  added: AssistantCalendar[]
  canEdit: boolean
  toast: (text: string) => void
}) {
  const listed = useCalendarList(connection.id)
  return (
    <>
      {toolTypeRows(added, listed.data ?? null).map(row =>
        row.added ? (
          <ToolTypeRow
            key={row.added.id}
            type={row.added}
            connection={connection}
            team={row.listed?.group}
            canEdit={canEdit}
          />
        ) : (
          row.listed && (
            <OffToolTypeRow
              key={`off-${row.listed.id}`}
              assistant={assistant}
              connection={connection}
              type={row.listed}
              canEdit={canEdit}
              toast={toast}
            />
          )
        ),
      )}
    </>
  )
}

/**
 * A Cal.com or Calendly account as one entry of the Calendars card: its mark and address, "Event types" to pick which
 * ones the assistant books, and the picked ones under it.
 */
function SchedulingToolEntry({
  assistant,
  connection,
  types,
  canEdit,
  onPick,
}: {
  assistant: Assistant
  connection: CalendarConnection
  types: AssistantCalendar[]
  canEdit: boolean
  onPick: () => void
}) {
  const t = useT()
  const provider = PROVIDER_LABEL[connection.provider]
  return (
    <ListRow
      className="cal-tool"
      lead={<SignInMark method={accountMark(connection)} />}
      title={provider}
      sub={connection.account_email}
      actions={canEdit && <PickButton connection={connection} onPick={onPick} />}
      below={
        types.length > 0 ? (
          <List className="cal-tool-types" label={t('settings.calendar.eventTypes.listLabel', { provider })}>
            {types.map(type => (
              <EventTypeRow key={type.id} type={type} canEdit={canEdit} />
            ))}
          </List>
        ) : (
          <p className="cal-tool-empty">{t('settings.calendar.eventTypes.none', { name: assistant.name, provider })}</p>
        )
      }
    />
  )
}

type Listed = ListCalendarsData['calendars'][number]

/** The calendars (or event types) of an account the assistant can book into; cached, shared by picker and list. */
function useCalendarList(connectionId: string) {
  return useQuery(`calendar.list.${connectionId}`, () =>
    callAction<ListCalendarsData>('calendar.listCalendars', { connectionId }).then(data =>
      data.calendars.filter(c => c.canWrite),
    ),
  )
}

/** Opens the picker of one account: "Calendars", or "Event types" for Cal.com and Calendly. */
function PickButton({ connection, onPick }: { connection: CalendarConnection; onPick: () => void }) {
  const t = useT()
  const provider = PROVIDER_LABEL[connection.provider]
  const tool = isSchedulingTool(connection.provider)
  return (
    <Button
      size="sm"
      icon="checks"
      disabled={connection.status !== 'connected'}
      title={
        tool
          ? t('settings.calendar.eventTypes.pickTip', { provider, email: connection.account_email })
          : t('settings.calendar.picker.tip', { email: connection.account_email })
      }
      onClick={onPick}
    >
      {tool ? t('settings.calendar.eventTypes.button') : t('settings.calendar.picker.button')}
    </Button>
  )
}

/**
 * The calendars of one account as checkboxes (a Cal.com or Calendly account: its event types, a Cal.com team's under
 * the team's name): the ones the assistant books into are ticked. Saving adds the newly ticked ones and removes the
 * unticked ones (assistantCalendar.add / .remove, one at a time). The one place to change the choice, also later.
 */
export function CalendarPicker({
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
  const provider = PROVIDER_LABEL[connection.provider]
  const tool = isSchedulingTool(connection.provider)
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
      toast(tool ? t('settings.calendar.eventTypes.saved', { provider }) : t('settings.calendar.picker.saved'))
      onClose()
    } catch (err) {
      setSaveError((err as Error).message)
      setSaving(false)
    }
  }
  const error = options ? null : listed.error
  const groups = groupByTeam(options ?? [])
  const what = tool ? t('settings.calendar.eventTypes.button') : t('settings.calendar.calendars')
  return (
    <Dialog
      title={
        tool
          ? t('settings.calendar.eventTypes.title', { provider })
          : t('settings.calendar.picker.title', { email: connection.account_email })
      }
      description={
        tool
          ? t('settings.calendar.eventTypes.description', { name: assistant.name, email: connection.account_email })
          : t('settings.calendar.picker.description', { name: assistant.name })
      }
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
        error={error}
        onRetry={() => void listed.reload()}
        skeleton={<SkeletonList rows={3} sub={false} action />}
      >
        {groups.map(group => (
          <div key={group.group ?? ''} className="cal-pick-group">
            {groups.length > 1 && <h3>{group.group ?? t('settings.calendar.picker.own')}</h3>}
            <ul className="k-list cal-pick" aria-label={group.group ?? what}>
              {group.calendars.map(c => (
                <li key={c.id} className="k-row">
                  <Checkbox checked={shown.has(c.id)} disabled={saving} onChange={on => toggle(c.id, on)}>
                    <span className="cal-pick-name">{c.name}</span>
                    {c.durationMin ? (
                      <span className="cal-pick-len">{durationLabel(c.durationMin)}</span>
                    ) : c.primary ? (
                      <span className="cal-pick-len">{t('settings.calendar.main')}</span>
                    ) : null}
                  </Checkbox>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {options?.length === 0 && (
          <ListEmpty>
            {tool ? t('settings.calendar.eventTypes.noneAtTool', { provider }) : t('settings.calendar.noWritable')}
          </ListEmpty>
        )}
      </Loading>
    </Dialog>
  )
}

/** The calendars the assistant books into; "Choose calendars" (or an account's own button) opens its picker. */
function Calendars({ assistant, canEdit, onPick }: Omit<Props, 'toast'> & { onPick: (connectionId: string) => void }) {
  const t = useT()
  const run = useRun()
  const connections = useRows('calendar_connections')
  const calendars = calendarsOf(useRows('assistant_calendars'), assistant.id)
  const ready = useCalendarsReady()
  const connected = connections
    .filter(c => c.status === 'connected')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const entries = calendarEntries(calendars, connections)
  const chooseTip = t('settings.calendar.chooseTip', { name: assistant.name })
  return (
    <Section
      id="as-cal-calendars"
      title={t('settings.calendar.calendars')}
      help={t('settings.calendar.calendarsHelp', { name: assistant.name })}
      actions={
        canEdit &&
        ready &&
        connected.length > 0 &&
        (connected.length === 1 ? (
          <Button size="sm" icon="checks" title={chooseTip} onClick={() => onPick(connected[0]!.id)}>
            {t('settings.calendar.choose')}
          </Button>
        ) : (
          <MenuButton
            label={t('settings.calendar.choose')}
            icon="checks"
            variant="secondary"
            title={chooseTip}
            items={connected.map(c => ({
              id: c.id,
              label: c.account_email,
              lead: <SignInMark method={accountMark(c)} />,
              onSelect: () => onPick(c.id),
            }))}
          />
        ))
      }
    >
      <Loading what={t('settings.calendar.calendars')} loading={!ready} skeleton={<SkeletonList rows={1} action />}>
        {entries.length > 0 ? (
          <List label={t('settings.calendar.calendars')}>
            {entries.map(entry =>
              entry.kind === 'tool' ? (
                <SchedulingToolEntry
                  key={entry.connection.id}
                  assistant={assistant}
                  connection={entry.connection}
                  types={entry.types}
                  canEdit={canEdit}
                  onPick={() => onPick(entry.connection.id)}
                />
              ) : (
                <CalendarRow
                  key={entry.calendar.id}
                  calendar={entry.calendar}
                  account={connections.find(a => a.id === entry.calendar.connection_id)}
                  canEdit={canEdit}
                  onRemove={() => void run('assistantCalendar.remove', { assistantCalendarId: entry.calendar.id })}
                />
              ),
            )}
          </List>
        ) : (
          <ListEmpty>
            {connected.length
              ? t('settings.calendar.noCalendar', { name: assistant.name })
              : t('settings.calendar.accountFirst', { name: assistant.name })}
          </ListEmpty>
        )}
      </Loading>
    </Section>
  )
}

/** The type form's choices, in the active language (cheap: built on each render of the form). */
const typeOptions = () => ({
  durations: DURATIONS.map(d => ({ value: String(d), label: durationLabel(d) })) as SelectOption<string>[],
  buffers: BUFFERS.map(b => ({ value: String(b), label: bufferLabel(b) })) as SelectOption<string>[],
  bookWhen: BOOK_WHEN.map(value => ({ value, label: bookWhenLabel(value) })) as SelectOption<BookWhen>[],
})

function TypeForm({ type, onDone }: { type?: AppointmentType; onDone: () => void }) {
  const t = useT()
  const run = useRun()
  const { durations: durationOptions, buffers: bufferOptions, bookWhen: bookWhenOptions } = typeOptions()
  const [name, setName] = useState(type?.name ?? '')
  const [duration, setDuration] = useState(String(type?.duration_min ?? 60))
  const [fields, setFields] = useState<BookingFieldId[]>(type ? typeFields(type) : ['name', 'address'])
  const [condition, setCondition] = useState(type?.instruction ?? '')
  const [before, setBefore] = useState(String(type?.buffer_before_min ?? 0))
  const [after, setAfter] = useState(String(type?.buffer_after_min ?? 0))
  const [when, setWhen] = useState<BookWhen>(type?.book_when ?? 'business_hours')
  const save = () => {
    if (!name.trim()) return
    void run('appointmentType.upsert', {
      ...(type ? { appointmentTypeId: type.id } : {}),
      name: name.trim(),
      durationMin: Number(duration),
      requiredFields: fields,
      instruction: condition.trim(),
      bufferBeforeMin: Number(before),
      bufferAfterMin: Number(after),
      bookWhen: when,
    })
    onDone()
  }
  // Enter in a field saves this type (Add or Save below), never the page's form around it (the Assistant Save).
  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    save()
  }
  return (
    <div className="cal-type-form">
      <div className="k-fields-2">
        <Field id="cal-type-name" label={t('settings.calendar.type.name')}>
          <Input
            id="cal-type-name"
            value={name}
            placeholder={t('settings.calendar.type.nameExample')}
            autoFocus
            onKeyDown={onEnter}
            onChange={e => setName(e.target.value)}
          />
        </Field>
        <Field id="cal-type-duration" label={t('settings.calendar.type.length')}>
          <Select
            id="cal-type-duration"
            label={t('settings.calendar.type.length')}
            value={duration}
            options={durationOptions}
            onChange={setDuration}
          />
        </Field>
      </div>
      <Field
        id="cal-type-when"
        label={t('settings.calendar.condition.type')}
        tip={t('settings.calendar.type.conditionTip')}
      >
        <Input
          id="cal-type-when"
          value={condition}
          placeholder={t('settings.calendar.condition.typeExample')}
          maxLength={CONDITION_MAX}
          onKeyDown={onEnter}
          onChange={e => setCondition(e.target.value)}
        />
      </Field>
      <div className="cal-type-rules">
        <Field
          id="cal-type-before"
          label={t('settings.calendar.type.bufferBefore')}
          tip={t('settings.calendar.type.bufferBeforeTip')}
        >
          <Select
            id="cal-type-before"
            label={t('settings.calendar.type.bufferBefore')}
            value={before}
            options={bufferOptions}
            onChange={setBefore}
          />
        </Field>
        <Field
          id="cal-type-after"
          label={t('settings.calendar.type.bufferAfter')}
          tip={t('settings.calendar.type.bufferAfterTip')}
        >
          <Select
            id="cal-type-after"
            label={t('settings.calendar.type.bufferAfter')}
            value={after}
            options={bufferOptions}
            onChange={setAfter}
          />
        </Field>
        <Field id="cal-type-hours" label={t('settings.calendar.type.canBeBooked')}>
          <span className="bh-with">
            <Select
              id="cal-type-hours"
              label={t('settings.calendar.type.canBeBooked')}
              value={when}
              options={bookWhenOptions}
              onChange={setWhen}
            />
            {when !== 'any_time' && <EditBusinessHours canEdit />}
          </span>
        </Field>
      </div>
      <Field label={t('settings.calendar.type.askFor')} tip={t('settings.calendar.type.askForTip')}>
        <span className="cal-type-fields">
          {BOOKING_FIELDS.map(f => (
            <Checkbox
              key={f}
              checked={fields.includes(f)}
              onChange={on => setFields(all => (on ? [...all, f] : all.filter(x => x !== f)))}
            >
              {fieldLabel(f)}
            </Checkbox>
          ))}
        </span>
      </Field>
      <span className="cal-type-foot">
        <Button variant="ghost" onClick={onDone}>
          {t('common.action.cancel')}
        </Button>
        <Button variant="primary" disabled={!name.trim()} onClick={save}>
          {type ? t('common.action.save') : t('settings.calendar.add')}
        </Button>
      </span>
    </div>
  )
}

function AppointmentTypes({ assistant, canEdit, toast }: Props) {
  const t = useT()
  const run = useRun()
  // A scheduling tool's calendar (Calendly, Cal.com) is an event type with its own length and rules: these types are
  // for the plain calendars only. All event types of each connected tool show here too, only on or off, with its mark.
  const connections = useRows('calendar_connections').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const toolTypes = calendarsOf(useRows('assistant_calendars'), assistant.id).filter(c => c.duration_min !== null)
  const tools = connections.filter(c => isSchedulingTool(c.provider) && c.status === 'connected')
  // Added types of an account that needs to be connected again: shown as they are.
  const stranded = toolTypes.filter(type => !tools.some(c => c.id === type.connection_id))
  const someTools = toolTypes.length > 0 || tools.length > 0
  const types = useRows('appointment_types')
    .filter(type => type.enabled)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <Section
      id="as-cal-types"
      title={t('settings.calendar.types')}
      help={someTools ? t('settings.calendar.typesToolsHelp') : undefined}
      actions={
        canEdit &&
        editing !== 'new' && (
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            {t('settings.calendar.addType')}
          </Button>
        )
      }
    >
      {types.length > 0 && (
        <List label={t('settings.calendar.types')}>
          {types.map(type =>
            editing === type.id ? (
              <li key={type.id} className="k-row">
                <TypeForm type={type} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <ListRow
                key={type.id}
                title={type.name}
                sub={[requiredLabel(type), rulesLabel(type)].filter(Boolean).join(' · ')}
                aside={durationLabel(type.duration_min)}
                below={
                  <ConditionField
                    what="type"
                    name={type.name}
                    value={type.instruction}
                    placeholder={t('settings.calendar.condition.typeExample')}
                    disabled={!canEdit}
                    onSave={instruction =>
                      void run('appointmentType.upsert', {
                        appointmentTypeId: type.id,
                        name: type.name,
                        durationMin: type.duration_min,
                        instruction,
                      })
                    }
                  />
                }
                actions={
                  canEdit && (
                    <>
                      <EditButton name={type.name} onClick={() => setEditing(type.id)} />
                      <DeleteButton
                        name={type.name}
                        onDelete={() => void run('appointmentType.delete', { appointmentTypeId: type.id })}
                      />
                    </>
                  )
                }
              />
            ),
          )}
        </List>
      )}
      {editing === 'new' && <TypeForm onDone={() => setEditing(null)} />}
      {!types.length && editing !== 'new' && <ListEmpty>{t('settings.calendar.noType')}</ListEmpty>}
      {someTools && (
        <List className="cal-tool-types" label={t('settings.calendar.toolTypes.listLabel')}>
          {tools.map(c => (
            <ToolTypes
              key={c.id}
              assistant={assistant}
              connection={c}
              added={toolTypes.filter(type => type.connection_id === c.id)}
              canEdit={canEdit}
              toast={toast}
            />
          ))}
          {stranded.map(type => (
            <ToolTypeRow
              key={type.id}
              type={type}
              connection={connections.find(c => c.id === type.connection_id)}
              canEdit={canEdit}
            />
          ))}
        </List>
      )}
    </Section>
  )
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

export function CalendarSettings(props: Props) {
  const returned = useConnectResult(props.toast)
  const ready = useCalendarsReady()
  const connected = useRows('calendar_connections')
    .filter(c => c.status === 'connected')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  /** The account whose picker is open: the one just connected (back from its consent page, or from a key form). */
  const [picking, setPicking] = useState<string | null>(props.canEdit ? returned : null)
  const pick = (connectionId: string) => setPicking(props.canEdit ? connectionId : null)
  // The rights can load after the first render: open the picker of the account just connected then.
  useEffect(() => {
    if (props.canEdit && returned !== null) setPicking(p => p ?? returned)
  }, [props.canEdit, returned])
  // '' when the callback did not name the account: the calendar account connected last.
  const target =
    picking === null || !ready
      ? undefined
      : picking
        ? connected.find(c => c.id === picking)
        : (connected.findLast(c => !isSchedulingTool(c.provider)) ?? connected.at(-1))
  // An account that is not (or no longer) connected: forget it, so its picker does not open later by surprise.
  useEffect(() => {
    if (ready && picking !== null && !target) setPicking(null)
  }, [ready, picking, target])
  return (
    <>
      <Accounts {...props} onConnected={pick} onPick={pick} />
      <Calendars assistant={props.assistant} canEdit={props.canEdit} onPick={pick} />
      <AppointmentTypes {...props} />
      {target && (
        <CalendarPicker
          key={target.id}
          assistant={props.assistant}
          connection={target}
          onClose={() => setPicking(null)}
          toast={props.toast}
        />
      )}
    </>
  )
}
