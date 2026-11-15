// Settings › Assistant › Calendar: connected Google, Microsoft and CalDAV (iCloud) accounts, the calendars this
// assistant books into (on or off, a note on when to use each, one default), and the appointment
// types it offers. Changes apply at once (not part of the page's Save): connecting leaves the page
// for the provider's consent screen anyway (or checks a CalDAV login in a dialog), and the rest are small,
// single changes through the outbox.
import type { ConnectStartData, DisconnectData, ListCalendarsData } from '@linedesk/actions'
import { CONDITION_MAX } from '@linedesk/actions'
import type { AppointmentType, Assistant, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
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
  BOOK_WHEN,
  BOOKING_FIELDS,
  type BookingFieldId,
  type BookWhen,
  BUFFERS,
  bookWhenLabel,
  bufferLabel,
  CONNECT_RETURN_KEY,
  calendarsOf,
  connectResult,
  DURATIONS,
  durationLabel,
  fieldLabel,
  isPasswordProvider,
  type KeyProviderId,
  PROVIDER_LABEL,
  type ProviderId,
  requiredLabel,
  rulesLabel,
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

/** Enter in a field of this section must not submit the page's form (the Assistant Save). */
const noSubmit = (e: KeyboardEvent) => {
  if (e.key === 'Enter') e.preventDefault()
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
          <SignInMark method={p} />
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
      lead={<SignInMark method={c.provider} />}
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
        lead: <SignInMark method={p} />,
        onSelect: () => void connect(p),
      }))}
    />
  )
}

function Accounts({ assistant, canEdit, toast, onConnected }: Props & { onConnected: (connectionId: string) => void }) {
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
                {canEdit && rowMenu(c)}
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
          noSubmit(e)
          if (e.key === 'Enter') e.currentTarget.blur()
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
      lead={account && <SignInMark method={account.provider} />}
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
 * The calendars of a connected account, to add one. Opens on `initialConnectionId` (the account just
 * connected) when given; the first calendar that can be added gets the focus, so Enter adds it.
 */
export function AddCalendar({
  assistant,
  connections,
  initialConnectionId,
  onClose,
  toast,
}: {
  assistant: Assistant
  connections: CalendarConnection[]
  initialConnectionId?: string
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const write = useWriteAction()
  const [connectionId, setConnectionId] = useState(
    connections.find(c => c.id === initialConnectionId)?.id ?? connections[0]?.id ?? '',
  )
  const listed = useQuery(connectionId ? `calendar.list.${connectionId}` : null, () =>
    callAction<ListCalendarsData>('calendar.listCalendars', { connectionId }).then(data =>
      data.calendars.filter(c => c.canWrite),
    ),
  )
  const calendars = listed.data ?? null
  const [addError, setError] = useState<string | null>(null)
  const error = calendars ? null : listed.error
  const [adding, setAdding] = useState<string | null>(null)
  const taken = useRows('assistant_calendars')
    .filter(c => c.assistant_id === assistant.id && c.connection_id === connectionId)
    .map(c => c.external_id)
  // Keyboard first: once the calendars are on screen, the first one that can be added has the focus.
  const focused = useRef(false)
  const focusFirst = (list: HTMLUListElement | null) => {
    if (!list || focused.current) return
    focused.current = true
    list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }
  async function add(externalId: string, name: string) {
    setAdding(externalId)
    try {
      await write('assistantCalendar.add', { assistantId: assistant.id, connectionId, externalId })
      toast(t('settings.calendar.added', { assistant: assistant.name, calendar: name }))
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setAdding(null)
    }
  }
  const accountOptions: SelectOption<string>[] = connections.map(c => ({ value: c.id, label: c.account_email }))
  return (
    <Dialog title={t('settings.calendar.addCalendarTitle')} onClose={onClose} size="sm">
      {connections.length > 1 && (
        <Field id="cal-account" label={t('settings.calendar.account')}>
          <Select
            id="cal-account"
            label={t('settings.calendar.account')}
            value={connectionId}
            options={accountOptions}
            onChange={setConnectionId}
          />
        </Field>
      )}
      {addError && <p className="k-field-msg">{addError}</p>}
      <Loading
        what={t('settings.calendar.calendars')}
        loading={!calendars}
        error={error}
        onRetry={() => void listed.reload()}
        skeleton={<SkeletonList rows={3} sub={false} action />}
      >
        {calendars && (
          <ul className="k-list" ref={focusFirst}>
            {calendars.map(c => (
              <ListRow
                key={c.id}
                title={c.name}
                sub={
                  c.durationMin
                    ? t('settings.calendar.eventType', { duration: durationLabel(c.durationMin) })
                    : c.primary
                      ? t('settings.calendar.main')
                      : undefined
                }
                actions={
                  <Button
                    busy={adding === c.id}
                    size="sm"
                    disabled={taken.includes(c.id) || adding !== null}
                    onClick={() => add(c.id, c.name)}
                  >
                    {taken.includes(c.id)
                      ? t('settings.calendar.addedBadge')
                      : adding === c.id
                        ? t('settings.calendar.adding')
                        : t('settings.calendar.add')}
                  </Button>
                }
              />
            ))}
          </ul>
        )}
        {calendars?.length === 0 && <ListEmpty>{t('settings.calendar.noWritable')}</ListEmpty>}
      </Loading>
    </Dialog>
  )
}

/** `pickFrom`: the account just connected (back from its consent page): its calendars open to pick one. */
function Calendars({ assistant, canEdit, toast, pickFrom }: Props & { pickFrom: string | null }) {
  const t = useT()
  const run = useRun()
  const connections = useRows('calendar_connections')
  const calendars = calendarsOf(useRows('assistant_calendars'), assistant.id)
  const ready = useCalendarsReady()
  /** The picker is open, on this account ('' for the first one). */
  const [adding, setAdding] = useState<string | null>(canEdit ? pickFrom : null)
  // An account connected on this page (CalDAV): its calendars open to pick one.
  useEffect(() => {
    if (canEdit && pickFrom) setAdding(pickFrom)
  }, [canEdit, pickFrom])
  const connected = connections.filter(c => c.status === 'connected')
  return (
    <Section
      id="as-cal-calendars"
      title={t('settings.calendar.calendars')}
      help={t('settings.calendar.calendarsHelp', { name: assistant.name })}
      actions={
        canEdit &&
        ready &&
        connected.length > 0 && (
          <Button size="sm" icon="plus" onClick={() => setAdding('')}>
            {t('settings.calendar.addCalendar')}
          </Button>
        )
      }
    >
      <Loading what={t('settings.calendar.calendars')} loading={!ready} skeleton={<SkeletonList rows={1} action />}>
        {calendars.length > 0 ? (
          <List label={t('settings.calendar.calendars')}>
            {calendars.map(c => (
              <CalendarRow
                key={c.id}
                calendar={c}
                account={connections.find(a => a.id === c.connection_id)}
                canEdit={canEdit}
                onRemove={() => void run('assistantCalendar.remove', { assistantCalendarId: c.id })}
              />
            ))}
          </List>
        ) : (
          <ListEmpty>
            {connected.length
              ? t('settings.calendar.noCalendar', { name: assistant.name })
              : t('settings.calendar.accountFirst', { name: assistant.name })}
          </ListEmpty>
        )}
      </Loading>
      {adding !== null && ready && connected.length > 0 && (
        <AddCalendar
          assistant={assistant}
          connections={connected}
          initialConnectionId={adding || undefined}
          onClose={() => setAdding(null)}
          toast={toast}
        />
      )}
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
  return (
    <div className="cal-type-form">
      <div className="k-fields-2">
        <Field id="cal-type-name" label={t('settings.calendar.type.name')}>
          <Input
            id="cal-type-name"
            value={name}
            placeholder={t('settings.calendar.type.nameExample')}
            autoFocus
            onKeyDown={noSubmit}
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
          onKeyDown={noSubmit}
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

function AppointmentTypes({ assistant, canEdit }: Omit<Props, 'toast'>) {
  const t = useT()
  const run = useRun()
  // A scheduling tool's calendar (Calendly, Cal.com) is an event type with its own length and rules: these types are
  // for the plain calendars only.
  const someTools = calendarsOf(useRows('assistant_calendars'), assistant.id).some(c => c.duration_min !== null)
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
  const [connectedHere, setConnectedHere] = useState<string | null>(null)
  return (
    <>
      <Accounts {...props} onConnected={setConnectedHere} />
      <Calendars {...props} pickFrom={connectedHere ?? returned} />
      <AppointmentTypes assistant={props.assistant} canEdit={props.canEdit} />
    </>
  )
}
