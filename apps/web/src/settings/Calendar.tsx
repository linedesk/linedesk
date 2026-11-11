// Settings › Assistant › Calendar: connected Google and Microsoft accounts, the calendars this
// assistant books into (on or off, a note on when to use each, one default), and the appointment
// types it offers. Changes apply at once (not part of the page's Save): connecting leaves the page
// for the provider's consent screen anyway, and the rest are small, single changes through the outbox.
import type { ConnectStartData, DisconnectData, ListCalendarsData } from '@linedesk/actions'
import { CALENDAR_INSTRUCTION_MAX } from '@linedesk/actions'
import type { AppointmentType, Assistant, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import { useRows, useRun } from '../store.tsx'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Skeleton, SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { useQuery } from '../cachedQuery.ts'
import {
  CONNECT_RETURN_KEY,
  calendarsOf,
  connectResult,
  DURATIONS,
  durationLabel,
  FIELD_LABEL,
  PROVIDER_LABEL,
  type ProviderId,
  requiredLabel,
} from './calendarModel.ts'
import { Field, Section } from './fields.tsx'
import { callAction, useWriteAction } from './settings-api.ts'
import './calendar.css'

type Props = { assistant: Assistant; canEdit: boolean; toast: (text: string) => void }

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
 * One button per calendar provider this install offers: it opens the provider's consent page, and the
 * callback brings the browser back to this app. Used in Settings and in onboarding.
 */
export function ConnectButtons({ assistantId, toast }: { assistantId: string; toast: (text: string) => void }) {
  const providers = useProviders()
  const [busy, setBusy] = useState<ProviderId | null>(null)

  async function connect(provider: ProviderId) {
    setBusy(provider)
    try {
      const { url } = await callAction<ConnectStartData>('calendar.connectStart', { provider })
      try {
        sessionStorage.setItem(CONNECT_RETURN_KEY, assistantId)
      } catch {}
      window.location.assign(url)
    } catch (e) {
      toast((e as Error).message)
      setBusy(null)
    }
  }

  if (!providers) return <Skeleton className="sk-field" />
  if (!providers.length)
    return (
      <p className="help">No calendar provider is set up on this server. An admin sets GOOGLE_CLIENT_ID or MICROSOFT_CLIENT_ID and its secret.</p>
    )
  return (
    <div className="cal-connect">
      {providers.map(p => (
        <Button key={p} disabled={busy !== null} onClick={() => connect(p)} title={`Connect a ${PROVIDER_LABEL[p]} calendar`}>
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
    <li className="cal-row">
      <SignInMark method={c.provider} />
      <span className="cal-main">
        <b>{c.account_email}</b>
        {c.status === 'needs_reconnect' && <span className="cal-sub">{c.last_error ?? 'Access was withdrawn.'}</span>}
      </span>
      {c.status === 'connected' ? (
        <Badge tone="ok" dot>
          Connected
        </Badge>
      ) : (
        <Badge tone="danger" dot>
          Connect again
        </Badge>
      )}
      {children}
    </li>
  )
}

function Accounts({ assistant, canEdit, toast }: Props) {
  const write = useWriteAction()
  const connections = useRows('calendar_connections').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const connectionsLoad = useLoadState('calendar_connections')
  const [busy, setBusy] = useState<string | null>(null)

  async function disconnect(connection: CalendarConnection) {
    if (!window.confirm(`Disconnect ${connection.account_email}? The assistant stops booking into its calendars. Booked events stay.`)) return
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

  return (
    <Section id="as-cal-accounts" title="Calendar accounts" description="The assistant checks them for free times and books into them.">
      {connectionsLoad !== 'ready' && <SkeletonRows label="Loading calendar accounts" rows={1} />}
      {connections.length > 0 && (
        <ul className="cal-list">
          {connections.map(c => (
            <AccountRow key={c.id} connection={c}>
              {canEdit && (
                <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => disconnect(c)} title={`Disconnect ${c.account_email}`}>
                  Disconnect
                </Button>
              )}
            </AccountRow>
          ))}
        </ul>
      )}
      {canEdit && <ConnectButtons assistantId={assistant.id} toast={toast} />}
    </Section>
  )
}

/** The note is saved when the field loses focus, so typing is not a command per key. */
function CalendarRow({ calendar, account, canEdit, onRemove }: { calendar: AssistantCalendar; account?: CalendarConnection; canEdit: boolean; onRemove: () => void }) {
  const run = useRun()
  const [note, setNote] = useState(calendar.instruction)
  useEffect(() => setNote(calendar.instruction), [calendar.instruction])
  const saveNote = () => {
    const value = note.trim()
    if (value !== calendar.instruction) void run('assistantCalendar.update', { assistantCalendarId: calendar.id, instruction: value })
  }
  return (
    <li className="cal-row cal-row-calendar">
      {account && <SignInMark method={account.provider} />}
      <span className="cal-main">
        <b>
          {calendar.name}
          {calendar.is_default && (
            <Badge tone="outline">Default</Badge>
          )}
        </b>
        <span className="cal-sub">{account?.account_email}</span>
        <Input
          aria-label={`When to use ${calendar.name}`}
          placeholder={calendar.is_default ? 'When no other calendar fits' : 'When to use it, e.g. Emergencies'}
          value={note}
          maxLength={CALENDAR_INSTRUCTION_MAX}
          disabled={!canEdit}
          onChange={e => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={e => {
            noSubmit(e)
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </span>
      <span className="cal-actions">
        <Switch
          label={`Book into ${calendar.name}`}
          on={calendar.enabled}
          disabled={!canEdit}
          onChange={on => void run('assistantCalendar.update', { assistantCalendarId: calendar.id, enabled: on })}
        />
        {canEdit && !calendar.is_default && (
          <Button size="sm" variant="ghost" onClick={() => void run('assistantCalendar.setDefault', { assistantCalendarId: calendar.id })}>
            Make default
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant="ghost" icon="close" aria-label={`Remove ${calendar.name}`} title={`Remove ${calendar.name}`} onClick={onRemove} />
        )}
      </span>
    </li>
  )
}

export function AddCalendar({ assistant, connections, onClose, toast }: { assistant: Assistant; connections: CalendarConnection[]; onClose: () => void; toast: (t: string) => void }) {
  const write = useWriteAction()
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const listed = useQuery(connectionId ? `calendar.list.${connectionId}` : null, () =>
    callAction<ListCalendarsData>('calendar.listCalendars', { connectionId }).then(data => data.calendars.filter(c => c.canWrite)),
  )
  const calendars = listed.data ?? null
  const [addError, setError] = useState<string | null>(null)
  const error = addError ?? (calendars ? null : listed.error)
  const [adding, setAdding] = useState<string | null>(null)
  const taken = useRows('assistant_calendars').filter(c => c.assistant_id === assistant.id && c.connection_id === connectionId).map(c => c.external_id)
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
    <Dialog title="Add a calendar" description={`${assistant.name} books into the calendars you add.`} onClose={onClose} size="sm">
      {connections.length > 1 && (
        <Field id="cal-account" label="Account">
          <Select id="cal-account" label="Account" value={connectionId} options={accountOptions} onChange={setConnectionId} />
        </Field>
      )}
      {error && <p className="k-field-msg">{error}</p>}
      {!calendars && !error && <SkeletonRows label="Loading calendars" rows={3} />}
      {calendars && (
        <ul className="cal-list">
          {calendars.map(c => (
            <li key={c.id} className="cal-row">
              <span className="cal-main">
                <b>{c.name}</b>
                {c.primary && <span className="cal-sub">Main calendar</span>}
              </span>
              <Button size="sm" disabled={taken.includes(c.id) || adding !== null} onClick={() => add(c.id, c.name)}>
                {taken.includes(c.id) ? 'Added' : adding === c.id ? 'Adding…' : 'Add'}
              </Button>
            </li>
          ))}
          {calendars.length === 0 && <li className="help">This account has no calendar you can add events to.</li>}
        </ul>
      )}
    </Dialog>
  )
}

function Calendars({ assistant, canEdit, toast }: Props) {
  const run = useRun()
  const connections = useRows('calendar_connections')
  const calendars = calendarsOf(useRows('assistant_calendars'), assistant.id)
  const [adding, setAdding] = useState(false)
  const connected = connections.filter(c => c.status === 'connected')
  return (
    <Section
      id="as-cal-calendars"
      title="Calendars"
      description={`Where ${assistant.name} books. Say when to use each one.`}
      help="The assistant picks the calendar whose note fits the call, else the default one. It only offers times that are free in that calendar and within business hours (Monday to Friday 9 to 5 while business hours are off)."
      actions={
        canEdit && connected.length > 0 && (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add calendar
          </Button>
        )
      }
    >
      {calendars.length > 0 ? (
        <ul className="cal-list">
          {calendars.map(c => (
            <CalendarRow
              key={c.id}
              calendar={c}
              account={connections.find(a => a.id === c.connection_id)}
              canEdit={canEdit}
              onRemove={() => void run('assistantCalendar.remove', { assistantCalendarId: c.id })}
            />
          ))}
        </ul>
      ) : (
        <p className="help">{connected.length ? `Add a calendar so ${assistant.name} can book.` : `Connect an account first. Until then ${assistant.name} takes messages.`}</p>
      )}
      {adding && <AddCalendar assistant={assistant} connections={connected} onClose={() => setAdding(false)} toast={toast} />}
    </Section>
  )
}

const durationOptions: SelectOption<string>[] = DURATIONS.map(d => ({ value: String(d), label: durationLabel(d) }))
const FIELDS = ['phone', 'email', 'address'] as const

function TypeForm({ type, onDone }: { type?: AppointmentType; onDone: () => void }) {
  const run = useRun()
  const [name, setName] = useState(type?.name ?? '')
  const [duration, setDuration] = useState(String(type?.duration_min ?? 60))
  const [fields, setFields] = useState<AppointmentType['required_fields']>(type?.required_fields ?? ['address'])
  const save = () => {
    if (!name.trim()) return
    void run('appointmentType.upsert', {
      ...(type ? { appointmentTypeId: type.id } : {}),
      name: name.trim(),
      durationMin: Number(duration),
      requiredFields: fields,
    })
    onDone()
  }
  return (
    <div className="cal-type-form">
      <Field id="cal-type-name" label="Name">
        <Input id="cal-type-name" value={name} placeholder="Repair visit" autoFocus onKeyDown={noSubmit} onChange={e => setName(e.target.value)} />
      </Field>
      <Field id="cal-type-duration" label="Length">
        <Select id="cal-type-duration" label="Length" value={duration} options={durationOptions} onChange={setDuration} />
      </Field>
      <Field label="Also ask for" tip="The assistant always asks for the caller's name and the reason.">
        <span className="cal-type-fields">
          {FIELDS.map(f => (
            <Checkbox key={f} checked={fields.includes(f)} onChange={on => setFields(all => (on ? [...all, f] : all.filter(x => x !== f)))}>
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
  const types = useRows('appointment_types').filter(t => t.enabled).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <Section
      id="as-cal-types"
      title="Appointment types"
      description="What callers can book, and how long it takes."
      actions={
        canEdit && editing !== 'new' && (
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            Add type
          </Button>
        )
      }
    >
      {types.length > 0 && (
        <ul className="cal-list">
          {types.map(t =>
            editing === t.id ? (
              <li key={t.id}>
                <TypeForm type={t} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={t.id} className="cal-row">
                <span className="cal-main">
                  <b>{t.name}</b>
                  <span className="cal-sub">{requiredLabel(t)}</span>
                </span>
                <span className="cal-sub">{durationLabel(t.duration_min)}</span>
                {canEdit && (
                  <span className="cal-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t.id)} title={`Edit ${t.name}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" icon="close" aria-label={`Delete ${t.name}`} title={`Delete ${t.name}`} onClick={() => void run('appointmentType.delete', { appointmentTypeId: t.id })} />
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {editing === 'new' && <TypeForm onDone={() => setEditing(null)} />}
      {!types.length && editing !== 'new' && <p className="help">Add at least one, for example "Repair visit, 1 h".</p>}
    </Section>
  )
}

/** Shows what the OAuth callback said once, then takes it out of the address. */
function useConnectResult(toast: (text: string) => void) {
  useEffect(() => {
    const result = connectResult(window.location.hash)
    if (!result) return
    toast(result.text)
    history.replaceState(null, '', window.location.hash.split('?')[0])
  }, [toast])
}

export function CalendarSettings(props: Props) {
  useConnectResult(props.toast)
  return (
    <>
      <Accounts {...props} />
      <Calendars {...props} />
      <AppointmentTypes canEdit={props.canEdit} />
    </>
  )
}
