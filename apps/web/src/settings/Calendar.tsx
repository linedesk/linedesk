// Settings › Assistant › Calendar: connected Google and Microsoft accounts, the calendars this
// assistant books into (on or off, a note on when to use each, one default), and the appointment
// types it offers. Changes apply at once (not part of the page's Save): connecting leaves the page
// for the provider's consent screen anyway, and the rest are small, single changes through the outbox.
import type { ConnectStartData, DisconnectData, ListCalendarsData } from '@linedesk/actions'
import { CONDITION_MAX } from '@linedesk/actions'
import type { AppointmentType, Assistant, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { useRows, useRun } from '../store.tsx'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow, MenuButton } from '../ui/list.tsx'
import { Skeleton, SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { useQuery } from '../cachedQuery.ts'
import {
  BOOKING_FIELDS,
  type BookingFieldId,
  CONNECT_RETURN_KEY,
  calendarsOf,
  connectResult,
  DURATIONS,
  durationLabel,
  FIELD_LABEL,
  PROVIDER_LABEL,
  type ProviderId,
  requiredLabel,
  typeFields,
} from './calendarModel.ts'
import { Field, Section } from './fields.tsx'
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

async function loadProviders(): Promise<ProviderId[]> {
  const res = await fetch('/v1/calendar/providers', { credentials: 'include' })
  if (!res.ok) throw new Error(`The server answered ${res.status}`)
  return ((await res.json()) as { providers: ProviderId[] }).providers
}

/** The calendar providers this install can connect: the last known at once; none when they cannot be read. */
function useProviders(): ProviderId[] | null {
  const { data, error } = useQuery('calendar.providers', loadProviders, { persist: true })
  return data ?? (error ? [] : null)
}

/**
 * Connecting an account: opens the provider's consent page, and the callback brings the browser back
 * to this app. `busy` is the provider whose page is opening.
 */
function useConnect(assistantId: string, toast: (text: string) => void) {
  const providers = useProviders()
  const [busy, setBusy] = useState<ProviderId | null>(null)

  async function connect(provider: ProviderId) {
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
  return { providers, busy, connect }
}

const noProviderText = 'No calendar provider on this server yet. Ask whoever runs your Linedesk.'

/** One button per calendar provider this install offers. Used in onboarding. */
export function ConnectButtons({ assistantId, toast }: { assistantId: string; toast: (text: string) => void }) {
  const { providers, busy, connect } = useConnect(assistantId, toast)
  if (!providers) return <Skeleton className="sk-field" />
  if (!providers.length) return <p className="help">{noProviderText}</p>
  return (
    <div className="cal-connect">
      {providers.map(p => (
        <Button
          key={p}
          disabled={busy !== null}
          onClick={() => connect(p)}
          title={`Connect a ${PROVIDER_LABEL[p]} calendar`}
        >
          <SignInMark method={p} />
          {busy === p ? `Opening ${PROVIDER_LABEL[p]}…` : `Connect ${PROVIDER_LABEL[p]}`}
        </Button>
      ))}
    </div>
  )
}

/** A connected account as a row: provider mark, address, and whether it still works. */
export function AccountRow({ connection, children }: { connection: CalendarConnection; children?: ReactNode }) {
  const c = connection
  return (
    <ListRow
      lead={<SignInMark method={c.provider} />}
      title={c.account_email}
      sub={c.status === 'needs_reconnect' ? (c.last_error ?? 'Access was withdrawn.') : undefined}
      aside={
        c.status === 'connected' ? (
          <Badge tone="ok" dot>
            Connected
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Connect again
          </Badge>
        )
      }
      actions={children}
    />
  )
}

/** "Add account": one button, then the choice of provider (only those this install offers). */
function AddAccount({ providers, busy, connect }: ReturnType<typeof useConnect>) {
  if (!providers?.length) return null
  return (
    <MenuButton
      label={busy ? `Opening ${PROVIDER_LABEL[busy]}…` : 'Add account'}
      icon="plus"
      variant="secondary"
      title="Connect a Google or Microsoft calendar account"
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

function Accounts({ assistant, canEdit, toast }: Props) {
  const write = useWriteAction()
  const connections = useRows('calendar_connections').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const ready = useLoadState('calendar_connections') === 'ready'
  const connector = useConnect(assistant.id, toast)
  const [busy, setBusy] = useState<string | null>(null)

  async function disconnect(connection: CalendarConnection) {
    if (
      !window.confirm(
        `Disconnect ${connection.account_email}? The assistant stops booking into its calendars. Booked events stay.`,
      )
    )
      return
    setBusy(connection.id)
    try {
      const { note } = await write<DisconnectData>('calendar.disconnect', { connectionId: connection.id })
      toast(note ?? `${connection.account_email} is disconnected.`)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const rowMenu = (c: CalendarConnection) => (
    <MenuButton
      title={`Actions for ${c.account_email}`}
      disabled={busy === c.id || connector.busy !== null}
      items={[
        ...(c.status === 'needs_reconnect'
          ? [{ id: 'reconnect', label: 'Connect again', onSelect: () => void connector.connect(c.provider) }]
          : []),
        { id: 'disconnect', label: 'Disconnect', danger: true, onSelect: () => void disconnect(c) },
      ]}
    />
  )

  return (
    <Section id="as-cal-accounts" title="Calendar accounts" actions={canEdit && ready && <AddAccount {...connector} />}>
      {!ready ? (
        <SkeletonRows label="Loading calendar accounts" rows={1} />
      ) : connections.length > 0 ? (
        <List label="Calendar accounts">
          {connections.map(c => (
            <AccountRow key={c.id} connection={c}>
              {canEdit && rowMenu(c)}
            </AccountRow>
          ))}
        </List>
      ) : (
        <ListEmpty>
          {connector.providers?.length === 0 ? noProviderText : `No account yet. Add one so ${assistant.name} can book.`}
        </ListEmpty>
      )}
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
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const save = () => {
    const next = text.trim()
    if (next !== value) onSave(next)
  }
  return (
    <span className="cal-cond">
      <span className="cal-cond-lead" aria-hidden="true">
        Use this {what} when
      </span>
      <Input
        aria-label={`Use ${name} when`}
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
  const run = useRun()
  return (
    <ListRow
      off={!calendar.enabled}
      lead={account && <SignInMark method={account.provider} />}
      title={
        <>
          {calendar.name}
          {calendar.is_default && <Badge tone="outline">Default</Badge>}
        </>
      }
      sub={account?.account_email}
      actions={
        <>
          <Switch
            label={`Book into ${calendar.name}`}
            on={calendar.enabled}
            disabled={!canEdit}
            onChange={on => void run('assistantCalendar.update', { assistantCalendarId: calendar.id, enabled: on })}
          />
          {canEdit && (
            <MenuButton
              title={`Actions for ${calendar.name}`}
              items={[
                ...(calendar.is_default
                  ? []
                  : [
                      {
                        id: 'default',
                        label: 'Make default',
                        onSelect: () => void run('assistantCalendar.setDefault', { assistantCalendarId: calendar.id }),
                      },
                    ]),
                { id: 'remove', label: 'Remove', danger: true, onSelect: onRemove },
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
          placeholder={calendar.is_default ? 'no other calendar fits' : 'the caller needs an emergency visit'}
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
  toast: (t: string) => void
}) {
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
  const error = addError ?? (calendars ? null : listed.error)
  const [adding, setAdding] = useState<string | null>(null)
  const taken = useRows('assistant_calendars')
    .filter(c => c.assistant_id === assistant.id && c.connection_id === connectionId)
    .map(c => c.external_id)
  // Keyboard first: once the calendars arrive, the first one that can be added has the focus.
  const list = useRef<HTMLUListElement>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (!calendars || focused.current) return
    focused.current = true
    list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [calendars])
  async function add(externalId: string, name: string) {
    setAdding(externalId)
    try {
      await write('assistantCalendar.add', { assistantId: assistant.id, connectionId, externalId })
      toast(`${assistant.name} can book into ${name} now.`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setAdding(null)
    }
  }
  const accountOptions: SelectOption<string>[] = connections.map(c => ({ value: c.id, label: c.account_email }))
  return (
    <Dialog title="Add a calendar" onClose={onClose} size="sm">
      {connections.length > 1 && (
        <Field id="cal-account" label="Account">
          <Select
            id="cal-account"
            label="Account"
            value={connectionId}
            options={accountOptions}
            onChange={setConnectionId}
          />
        </Field>
      )}
      {error && <p className="k-field-msg">{error}</p>}
      {!calendars && !error && <SkeletonRows label="Loading calendars" rows={3} />}
      {calendars && (
        <ul className="k-list" ref={list}>
          {calendars.map(c => (
            <ListRow
              key={c.id}
              title={c.name}
              sub={c.primary ? 'Main calendar' : undefined}
              actions={
                <Button size="sm" disabled={taken.includes(c.id) || adding !== null} onClick={() => add(c.id, c.name)}>
                  {taken.includes(c.id) ? 'Added' : adding === c.id ? 'Adding…' : 'Add'}
                </Button>
              }
            />
          ))}
        </ul>
      )}
      {calendars?.length === 0 && <ListEmpty>This account has no calendar you can add events to.</ListEmpty>}
    </Dialog>
  )
}

/** `pickFrom`: the account just connected (back from its consent page): its calendars open to pick one. */
function Calendars({ assistant, canEdit, toast, pickFrom }: Props & { pickFrom: string | null }) {
  const run = useRun()
  const connections = useRows('calendar_connections')
  const calendars = calendarsOf(useRows('assistant_calendars'), assistant.id)
  const ready = useCalendarsReady()
  /** The picker is open, on this account ('' for the first one). */
  const [adding, setAdding] = useState<string | null>(canEdit ? pickFrom : null)
  const connected = connections.filter(c => c.status === 'connected')
  return (
    <Section
      id="as-cal-calendars"
      title="Calendars"
      help={`${assistant.name} books appointments into the calendar whose note fits the call, otherwise into the default one. It only offers times that are free in that calendar and inside your business hours (Monday to Friday, 9 to 5, while business hours are off).`}
      actions={
        canEdit &&
        ready &&
        connected.length > 0 && (
          <Button size="sm" icon="plus" onClick={() => setAdding('')}>
            Add calendar
          </Button>
        )
      }
    >
      {!ready ? (
        <SkeletonRows label="Loading calendars" rows={1} />
      ) : calendars.length > 0 ? (
        <List label="Calendars">
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
            ? `No calendar yet. Add one so ${assistant.name} can book.`
            : `Add an account first. Until then ${assistant.name} takes messages.`}
        </ListEmpty>
      )}
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

const durationOptions: SelectOption<string>[] = DURATIONS.map(d => ({ value: String(d), label: durationLabel(d) }))

function TypeForm({ type, onDone }: { type?: AppointmentType; onDone: () => void }) {
  const run = useRun()
  const [name, setName] = useState(type?.name ?? '')
  const [duration, setDuration] = useState(String(type?.duration_min ?? 60))
  const [fields, setFields] = useState<BookingFieldId[]>(type ? typeFields(type) : ['name', 'address'])
  const [condition, setCondition] = useState(type?.instruction ?? '')
  const save = () => {
    if (!name.trim()) return
    void run('appointmentType.upsert', {
      ...(type ? { appointmentTypeId: type.id } : {}),
      name: name.trim(),
      durationMin: Number(duration),
      requiredFields: fields,
      instruction: condition.trim(),
    })
    onDone()
  }
  return (
    <div className="cal-type-form">
      <div className="k-fields-2">
        <Field id="cal-type-name" label="Name">
          <Input
            id="cal-type-name"
            value={name}
            placeholder="Repair visit"
            autoFocus
            onKeyDown={noSubmit}
            onChange={e => setName(e.target.value)}
          />
        </Field>
        <Field id="cal-type-duration" label="Length">
          <Select
            id="cal-type-duration"
            label="Length"
            value={duration}
            options={durationOptions}
            onChange={setDuration}
          />
        </Field>
      </div>
      <Field
        id="cal-type-when"
        label="Use this type when"
        tip="The assistant picks the type whose condition fits the call."
      >
        <Input
          id="cal-type-when"
          value={condition}
          placeholder="the caller needs a repair visit"
          maxLength={CONDITION_MAX}
          onKeyDown={noSubmit}
          onChange={e => setCondition(e.target.value)}
        />
      </Field>
      <Field
        label="Ask for"
        tip="Your assistant always asks what the appointment is for. Tick anything else it should ask before booking this type."
      >
        <span className="cal-type-fields">
          {BOOKING_FIELDS.map(f => (
            <Checkbox
              key={f}
              checked={fields.includes(f)}
              onChange={on => setFields(all => (on ? [...all, f] : all.filter(x => x !== f)))}
            >
              {FIELD_LABEL[f]}
            </Checkbox>
          ))}
        </span>
      </Field>
      <span className="cal-type-foot">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim()} onClick={save}>
          {type ? 'Save' : 'Add'}
        </Button>
      </span>
    </div>
  )
}

function AppointmentTypes({ canEdit }: Omit<Props, 'assistant' | 'toast'>) {
  const run = useRun()
  const types = useRows('appointment_types')
    .filter(t => t.enabled)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <Section
      id="as-cal-types"
      title="Appointment types"
      actions={
        canEdit &&
        editing !== 'new' && (
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            Add type
          </Button>
        )
      }
    >
      {types.length > 0 && (
        <List label="Appointment types">
          {types.map(t =>
            editing === t.id ? (
              <li key={t.id} className="k-row">
                <TypeForm type={t} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <ListRow
                key={t.id}
                title={t.name}
                sub={requiredLabel(t)}
                aside={durationLabel(t.duration_min)}
                below={
                  <ConditionField
                    what="type"
                    name={t.name}
                    value={t.instruction}
                    placeholder="the caller needs a repair visit"
                    disabled={!canEdit}
                    onSave={instruction =>
                      void run('appointmentType.upsert', {
                        appointmentTypeId: t.id,
                        name: t.name,
                        durationMin: t.duration_min,
                        instruction,
                      })
                    }
                  />
                }
                actions={
                  canEdit && (
                    <MenuButton
                      title={`Actions for ${t.name}`}
                      items={[
                        { id: 'edit', label: 'Edit', onSelect: () => setEditing(t.id) },
                        {
                          id: 'delete',
                          label: 'Delete',
                          danger: true,
                          onSelect: () => void run('appointmentType.delete', { appointmentTypeId: t.id }),
                        },
                      ]}
                    />
                  )
                }
              />
            ),
          )}
        </List>
      )}
      {editing === 'new' && <TypeForm onDone={() => setEditing(null)} />}
      {!types.length && editing !== 'new' && (
        <ListEmpty>No type yet. Add one, for example "Repair visit, 1 h".</ListEmpty>
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
  const connected = useConnectResult(props.toast)
  return (
    <>
      <Accounts {...props} />
      <Calendars {...props} pickFrom={connected} />
      <AppointmentTypes canEdit={props.canEdit} />
    </>
  )
}
