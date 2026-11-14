// Settings > Assistant > Hours & holidays, below the weekly hours: the days the business is closed, and
// vacation or closure mode (a date range with its own greeting). Workspace-wide like the hours.
//
// Closed days come from three places, shown together in "Next closed days": the public holiday calendar the
// workspace follows (country and state; every year, less the holidays it is open on), its own days (closed
// all day or shorter hours, once or every year), and single dates changed for this year (open, or shorter
// hours). The server keeps the next twelve months written (holidays.set, closedDays.set, public-holidays.ts).
import type { ClosedDay, HolidayLookupData, WorkspaceSettingsData } from '@linedesk/actions'
import type { Closure, HolidayCalendar } from '@linedesk/db/types'
import { type FormEvent, useEffect, useState } from 'react'
import { useRun } from '../store.tsx'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow, MenuButton, type MenuItem } from '../ui/list.tsx'
import { timeOptions } from './businessHoursModel.ts'
import {
  addDays,
  calendarSummary,
  closureProblem,
  closureState,
  closureSummary,
  dayHoursLabel,
  defaultClosureGreeting,
  derivedAfter,
  shortDate,
  todayIn,
  type UpcomingDay,
  upcomingDays,
  withChange,
  withDays,
} from './closedDaysModel.ts'
import { Field, Section, TextArea } from './fields.tsx'
import {
  callAction,
  patchWorkspaceSettings,
  readAction,
  refreshWorkspaceSettings,
  useWorkspaceSettings,
} from './settings-api.ts'

type Props = { canEdit: boolean; toast: (text: string) => void }

/** How many closed days show before "Show all". */
const FIRST_DAYS = 5
const startOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '24:00')
const endOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '00:00')

/**
 * The workspace's closed days and closure: what is saved, and how to change it. A change shows at once (as far
 * as the browser can tell), then the server's answer, which knows the holidays, replaces it.
 */
function useClosedDays(toast?: (text: string) => void) {
  const run = useRun()
  const settings = useWorkspaceSettings()
  const today = todayIn(settings.data?.timeZone ?? 'America/New_York')
  const own = settings.data?.closedDays ?? []
  const derived = settings.data?.derivedDays ?? []
  const calendar = settings.data?.holidays ?? null
  async function save(action: string, input: object, now: Partial<WorkspaceSettingsData>) {
    patchWorkspaceSettings(now)
    try {
      patchWorkspaceSettings(await callAction<Partial<WorkspaceSettingsData>>(action, input))
    } catch (e) {
      toast?.((e as Error).message)
      void refreshWorkspaceSettings()
    }
  }
  return {
    loaded: !!settings.data,
    today,
    own,
    derived,
    calendar,
    closure: settings.data?.closure ?? null,
    /** The own days, replaced as a whole; their later years come back from the server. */
    setOwn: (next: ClosedDay[]) =>
      save(
        'closedDays.set',
        { days: next },
        {
          closedDays: next,
          derivedDays: derived.filter(d => d.source !== 'repeat' || next.some(o => o.yearly && o.date === d.key)),
        },
      ),
    setCalendar: (next: HolidayCalendar) =>
      save('holidays.set', next, { holidays: next, derivedDays: derivedAfter(derived, next) }),
    setClosure: (closure: Closure | null) => {
      patchWorkspaceSettings({ closure })
      void run('workspace.updateSettings', { closure })
    },
  }
}

export function Holidays({ canEdit, toast }: Props) {
  const { loaded, today, own, derived, calendar, setOwn, setCalendar } = useClosedDays(toast)
  // Without weekly hours there are none to apply: the empty list says only that there are no closed days.
  const hoursOn = useWorkspaceSettings().data?.businessHoursOn ?? false
  const [choosing, setChoosing] = useState(false)
  const [all, setAll] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const days = upcomingDays(own, derived, calendar, today)
  const shown = all ? days : days.slice(0, FIRST_DAYS)

  function setHours(day: UpcomingDay, hours: { start: string; end: string } | null) {
    setEditing(null)
    if (day.kind === 'own') {
      setOwn(own.map(d => (d.date === day.date ? { ...d, start: hours?.start ?? null, end: hours?.end ?? null } : d)))
    } else if (calendar) {
      setCalendar(
        withChange(calendar, day.date, hours ? { date: day.date, name: day.name, open: false, ...hours } : null),
      )
    }
  }
  /** Repeats and holidays are changed for this year through the calendar; it may not exist yet for a repeat. */
  const calendarOrOff = (): HolidayCalendar =>
    calendar ?? { on: false, country: 'US', state: null, off: [], changes: [] }

  function itemsFor(day: UpcomingDay): MenuItem[] {
    const label = day.name || shortDate(day.date, today)
    const hours: MenuItem = day.start
      ? { id: 'closed', label: 'Closed all day', onSelect: () => setHours(day, null) }
      : { id: 'hours', label: 'Shorter hours…', onSelect: () => setEditing(day.date) }
    if (day.kind === 'own') {
      return [
        hours,
        day.yearly
          ? {
              id: 'once',
              label: 'Only this year',
              onSelect: () => setOwn(own.map(d => (d.date === day.date ? { ...d, yearly: false } : d))),
            }
          : {
              id: 'yearly',
              label: 'Every year',
              onSelect: () => setOwn(own.map(d => (d.date === day.date ? { ...d, yearly: true } : d))),
            },
        {
          id: 'remove',
          label: day.yearly ? 'Remove, every year' : 'Remove',
          danger: true,
          onSelect: () => {
            setOwn(own.filter(d => d.date !== day.date))
            toast(`Removed ${label}.`)
          },
        },
      ]
    }
    const openThisYear: MenuItem = {
      id: 'open',
      label: 'Open this year',
      onSelect: () => {
        setCalendar(
          withChange(calendarOrOff(), day.date, { date: day.date, name: day.name, open: true, start: null, end: null }),
        )
        toast(`Open on ${label} this year.`)
      },
    }
    if (day.kind === 'holiday' && calendar) {
      return [
        openThisYear,
        {
          id: 'always',
          label: `Open every year on ${day.key}`,
          onSelect: () => {
            setCalendar({
              ...calendar,
              off: [...calendar.off, day.key],
              changes: calendar.changes.filter(c => c.date !== day.date),
            })
            toast(`Open every year on ${day.key}.`)
          },
        },
        hours,
      ]
    }
    return [
      openThisYear,
      hours,
      {
        id: 'remove',
        label: 'Remove, every year',
        danger: true,
        onSelect: () => {
          setOwn(own.filter(d => d.date !== day.key))
          toast(`Removed ${label}, every year.`)
        },
      },
    ]
  }

  function sub(day: UpcomingDay) {
    const from = {
      own: day.yearly ? 'Every year' : 'Your day',
      holiday: 'Public holiday',
      repeat: 'Every year',
      opened: 'Open this year',
    }[day.kind]
    return `${shortDate(day.date, today)} · ${from}${day.changed && day.kind !== 'opened' ? ', hours this year' : ''}`
  }

  return (
    <Section
      id="as-holidays"
      title="Holidays and closures"
      description="Days you are closed, whatever the weekly hours say."
      help="On these days the assistant tells callers you are closed and when you open again, and books no appointments. It also mentions holidays in the next two weeks when callers ask about your hours. Public holidays and days you mark Every year come back by themselves each year."
    >
      {loaded && (
        <List label="Public holidays" className="hd-calendar">
          <CalendarRow
            calendar={calendar}
            canEdit={canEdit}
            onChoose={() => setChoosing(true)}
            onToggle={on => calendar && setCalendar({ ...calendar, on })}
          />
        </List>
      )}
      {choosing && (
        <CalendarDialog
          calendar={calendar}
          today={today}
          onClose={() => setChoosing(false)}
          onSave={next => {
            setCalendar(next)
            setChoosing(false)
            toast(calendar ? 'Public holidays saved.' : 'Public holidays are on. They come back every year.')
          }}
        />
      )}
      <h3 className="hd-heading">Next closed days</h3>
      {!loaded ? null : days.length ? (
        <>
          <List label="Next closed days">
            {shown.map(d => (
              <ListRow
                key={d.date}
                off={d.kind === 'opened'}
                title={d.name || shortDate(d.date, today)}
                sub={sub(d)}
                aside={d.kind !== 'opened' && <span className="help">{dayHoursLabel(d)}</span>}
                actions={
                  canEdit &&
                  (d.kind === 'opened' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => calendar && setCalendar(withChange(calendar, d.date, null))}
                    >
                      Close again
                    </Button>
                  ) : (
                    <MenuButton title={`More for ${d.name || shortDate(d.date, today)}`} items={itemsFor(d)} />
                  ))
                }
                below={
                  editing === d.date && (
                    <ShorterHours onCancel={() => setEditing(null)} onSave={hours => setHours(d, hours)} />
                  )
                }
              />
            ))}
          </List>
          {days.length > FIRST_DAYS && (
            <Button size="sm" variant="ghost" className="hd-more" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${days.length}`}
            </Button>
          )}
        </>
      ) : (
        <ListEmpty>
          {hoursOn ? 'No closed days yet: the weekly hours apply every day.' : 'No closed days yet.'}
        </ListEmpty>
      )}
      {canEdit && <AddDay own={own} today={today} toast={toast} onAdd={day => setOwn(withDays(own, [day]))} />}
    </Section>
  )
}

/** The public holiday calendar: not set up (one button), or which one, with a switch and Change. */
function CalendarRow({
  calendar,
  canEdit,
  onChoose,
  onToggle,
}: {
  calendar: HolidayCalendar | null
  canEdit: boolean
  onChoose: () => void
  onToggle: (on: boolean) => void
}) {
  const names = usePlaceNames(calendar)
  if (!calendar) {
    return (
      <ListRow
        title="Public holidays"
        sub="Closed on your public holidays, every year by itself."
        actions={
          canEdit && (
            <Button size="sm" icon="calendar" onClick={onChoose}>
              Choose holidays
            </Button>
          )
        }
      />
    )
  }
  return (
    <ListRow
      off={!calendar.on}
      title="Public holidays"
      sub={
        calendar.on
          ? names
            ? calendarSummary(calendar, names.country, names.state)
            : '…'
          : 'Off: public holidays are not closed days.'
      }
      actions={
        <>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={onChoose}>
              Change
            </Button>
          )}
          <Switch on={calendar.on} onChange={onToggle} label="Public holidays" disabled={!canEdit} />
        </>
      }
    />
  )
}

/** The names of the calendar's country and state ("United States of America", "California"), once looked up. */
function usePlaceNames(calendar: HolidayCalendar | null) {
  const [names, setNames] = useState<{ country: string; state: string | null } | null>(null)
  const country = calendar?.country
  const state = calendar?.state ?? undefined
  useEffect(() => {
    if (!country) return
    let current = true
    readAction<HolidayLookupData>('holidays.lookup', { country, state })
      .then(d => {
        if (!current) return
        setNames({
          country: d.countries.find(c => c.code === country)?.name ?? country,
          state: state ? (d.states.find(s => s.code === state)?.name ?? state) : null,
        })
      })
      .catch(() => current && setNames({ country, state: state ?? null }))
    return () => {
      current = false
    }
  }, [country, state])
  return names
}

/** Open only part of a closed day: from and until, every half hour. */
function ShorterHours({
  onSave,
  onCancel,
}: {
  onSave: (hours: { start: string; end: string }) => void
  onCancel: () => void
}) {
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('12:00')
  return (
    <div className="hd-hours">
      <Select size="sm" label="Opens" value={start} options={startOptions} onChange={setStart} />
      <span className="help">to</span>
      <Select size="sm" label="Closes" value={end} options={endOptions} onChange={setEnd} />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" disabled={end <= start} onClick={() => onSave({ start, end })}>
        Save hours
      </Button>
    </div>
  )
}

/** Add an own day: a date, a name, once or every year. */
function AddDay({
  own,
  today,
  toast,
  onAdd,
}: {
  own: readonly ClosedDay[]
  today: string
  toast: (text: string) => void
  onAdd: (day: ClosedDay) => void
}) {
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [yearly, setYearly] = useState(false)
  function add(e: FormEvent) {
    e.preventDefault()
    if (!date || date < today) return toast('Pick a day from today on.')
    if (own.some(d => d.date === date)) return toast(`${shortDate(date, today)} is in the list already.`)
    onAdd({ date, name: name.trim(), start: null, end: null, yearly })
    setDate('')
    setName('')
    setYearly(false)
  }
  return (
    <form className="st-inline hd-add" onSubmit={add}>
      <Input
        type="date"
        value={date}
        min={today}
        onChange={e => setDate(e.target.value)}
        aria-label="Day"
        className="hd-date"
      />
      <Input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Name, e.g. Staff training"
        aria-label="Name"
        maxLength={80}
      />
      <Checkbox checked={yearly} onChange={setYearly} className="hd-yearly">
        Every year
      </Checkbox>
      <Button size="sm" type="submit" disabled={!date}>
        Add day
      </Button>
    </form>
  )
}

type CalendarDialogProps = {
  calendar: HolidayCalendar | null
  today: string
  onClose: () => void
  onSave: (next: HolidayCalendar) => void
}

/**
 * Which public holidays close the business: a country (first the saved one, else the workspace time zone's)
 * and a state, and its holidays of the next twelve months, checked unless the business is open on them every
 * year. Unchecked holidays stay unchecked in later years too.
 */
function CalendarDialog({ calendar, today, onClose, onSave }: CalendarDialogProps) {
  const [place, setPlace] = useState<{ country?: string; state?: string }>(
    calendar ? { country: calendar.country, state: calendar.state ?? undefined } : {},
  )
  const [data, setData] = useState<HolidayLookupData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Open on these every year; kept across a change of state, so the same holiday stays unchecked.
  const [off, setOff] = useState<Set<string>>(new Set(calendar?.off ?? []))
  useEffect(() => {
    let current = true
    setError(null)
    setLoading(true)
    readAction<HolidayLookupData>('holidays.lookup', place)
      .then(next => current && setData(next))
      .catch((e: Error) => current && setError(e.message))
      .finally(() => current && setLoading(false))
    return () => {
      current = false
    }
  }, [place])
  function toggle(key: string, closed: boolean) {
    const next = new Set(off)
    if (closed) next.delete(key)
    else next.add(key)
    setOff(next)
  }
  const closedCount = data ? data.holidays.filter(h => !off.has(h.key)).length : 0
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!data || loading) return
    const samePlace = calendar?.country === data.country && calendar.state === data.state
    onSave({
      on: true,
      country: data.country,
      state: data.state,
      // Only holidays of this calendar; one unchecked elsewhere means nothing here.
      off: [...off].filter(k => data.holidays.some(h => h.key === k)),
      changes: samePlace ? (calendar?.changes ?? []) : [],
    })
  }
  return (
    <Dialog
      title="Public holidays"
      description="Closed on these every year. Uncheck the holidays you are open on; that stays so in later years."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={loading || !data} title="Save (⌘S)">
            {calendar?.on ? 'Save' : `Close on ${closedCount} holidays`}
          </Button>
        </>
      }
    >
      {data && (
        <div className="hd-place">
          <Field id="hd-country" label="Country">
            <Select
              id="hd-country"
              label="Country"
              value={data.country}
              options={data.countries.map(c => ({ value: c.code, label: c.name }))}
              onChange={country => setPlace({ country })}
            />
          </Field>
          {data.states.length > 0 && (
            <Field id="hd-state" label="State or region">
              <Select
                id="hd-state"
                label="State or region"
                value={data.state ?? ''}
                options={[
                  { value: '', label: 'Nationwide only' },
                  ...data.states.map(s => ({ value: s.code, label: s.name })),
                ]}
                onChange={state => setPlace({ country: data.country, state: state || undefined })}
              />
            </Field>
          )}
        </div>
      )}
      {error ? (
        <p className="help">{error}</p>
      ) : !data ? (
        <p className="help">Loading holidays…</p>
      ) : data.holidays.length ? (
        <List label="Public holidays">
          {data.holidays.map(h => (
            <ListRow
              key={h.key}
              title={
                <Checkbox checked={!off.has(h.key)} onChange={closed => toggle(h.key, closed)}>
                  {h.key}
                </Checkbox>
              }
              aside={<span className="help">{shortDate(h.date, today)}</span>}
            />
          ))}
        </List>
      ) : (
        <ListEmpty>No public holidays known for the next twelve months.</ListEmpty>
      )}
    </Dialog>
  )
}

/** Vacation or closure mode: off, being set up, or on (scheduled, running or ended) with Edit and Turn off. */
export function VacationMode({ canEdit, toast }: Props) {
  const { loaded, today, closure, setClosure } = useClosedDays()
  const [draft, setDraft] = useState<Closure | null>(null)
  const active = closure && closureState(closure, today) !== 'ended' ? closure : null
  function start() {
    const until = addDays(today, 6)
    setDraft(
      closure && closureState(closure, today) !== 'ended'
        ? closure
        : { from: today, until, greeting: defaultClosureGreeting(until) },
    )
  }
  function save(e: FormEvent) {
    e.preventDefault()
    if (!draft) return
    const problem = closureProblem(draft)
    if (problem) return toast(problem)
    setClosure({ ...draft, greeting: draft.greeting.trim() })
    setDraft(null)
    toast(closureState(draft, today) === 'on' ? 'Vacation mode is on.' : 'Vacation mode is scheduled.')
  }
  function turnOff() {
    setClosure(null)
    setDraft(null)
    toast('Vacation mode is off.')
  }
  /** Moving the last day keeps a greeting the owner did not write in step. */
  function setUntil(until: string) {
    if (!draft) return
    const generated = draft.greeting === defaultClosureGreeting(draft.until)
    setDraft({ ...draft, until, greeting: generated ? defaultClosureGreeting(until) : draft.greeting })
  }
  const on = !!active || !!draft
  return (
    <Section
      id="as-vacation"
      title="Vacation mode"
      description={active ? closureSummary(active, today) : 'Closed for a few days or weeks, with its own greeting.'}
      help="While it is on, the assistant greets callers with the vacation greeting, says when you are back, takes messages and books nothing. Nobody is put through; urgent calls are marked urgent. It ends by itself after the last day."
      actions={
        <Switch
          on={on}
          onChange={next => (next ? start() : active ? turnOff() : setDraft(null))}
          label="Vacation mode"
          disabled={!canEdit || !loaded}
        />
      }
    >
      {draft ? (
        <form className="hd-vac" onSubmit={save}>
          <div className="hd-range">
            <Field id="hd-from" label="First day closed">
              <Input
                id="hd-from"
                type="date"
                value={draft.from}
                min={today}
                onChange={e => setDraft({ ...draft, from: e.target.value })}
              />
            </Field>
            <Field id="hd-until" label="Last day closed">
              <Input
                id="hd-until"
                type="date"
                value={draft.until}
                min={draft.from || today}
                onChange={e => setUntil(e.target.value)}
              />
            </Field>
          </div>
          <Field id="hd-greeting" label="Greeting while closed" aside="Optional">
            <TextArea
              id="hd-greeting"
              value={draft.greeting}
              onChange={greeting => setDraft({ ...draft, greeting })}
              placeholder="Empty: the outside-hours greeting"
            />
          </Field>
          <div className="hd-actions">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit">
              {active ? 'Save' : 'Turn on'}
            </Button>
          </div>
        </form>
      ) : active ? (
        <div className="hd-on">
          <p className="hd-quote">"{active.greeting || 'The outside-hours greeting'}"</p>
          <span className="help">Every call gets a message, nobody is called.</span>
          {canEdit && (
            <div className="hd-actions">
              <Button size="sm" variant="ghost" onClick={turnOff}>
                Turn off
              </Button>
              <Button size="sm" onClick={start}>
                Edit
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Section>
  )
}
