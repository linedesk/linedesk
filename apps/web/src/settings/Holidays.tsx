// Settings > Assistant > Hours & holidays, below the weekly hours: holidays and closure days (closed
// all day, or the hours they had), and vacation or closure mode (a date range with its own greeting).
// Workspace-wide like the hours. Each change saves at once.
import type { ClosedDay } from '@linedesk/actions'
import type { Closure } from '@linedesk/db/types'
import { type FormEvent, useState } from 'react'
import { useRun } from '../store.tsx'
import { Switch } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Field, Section, TextArea } from './fields.tsx'
import {
  addDays,
  closureProblem,
  closureState,
  closureSummary,
  dayHoursLabel,
  defaultClosureGreeting,
  shortDate,
  todayIn,
  withDays,
} from './closedDaysModel.ts'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'

type Props = { canEdit: boolean; toast: (text: string) => void }

/** The workspace's holidays and closure: what is saved, and how to change it (at once, locally first). */
function useClosedDays() {
  const run = useRun()
  const settings = useWorkspaceSettings()
  const today = todayIn(settings.data?.timeZone ?? 'America/New_York')
  const days = settings.data?.closedDays ?? []
  return {
    loaded: !!settings.data,
    today,
    days,
    closure: settings.data?.closure ?? null,
    setDays: (next: ClosedDay[]) => {
      patchWorkspaceSettings({ closedDays: next })
      void run('closedDays.set', { days: next })
    },
    setClosure: (closure: Closure | null) => {
      patchWorkspaceSettings({ closure })
      void run('workspace.updateSettings', { closure })
    },
  }
}

export function Holidays({ canEdit, toast }: Props) {
  const { loaded, today, days, setDays } = useClosedDays()
  // Without weekly hours there are none to apply: the empty list says only that there are no holidays.
  const hoursOn = useWorkspaceSettings().data?.businessHoursOn ?? false
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  // Past days stay saved (they change nothing) but are not shown.
  const upcoming = days.filter(d => d.date >= today)
  function add(e: FormEvent) {
    e.preventDefault()
    if (!date || date < today) return toast('Pick a day from today on.')
    if (days.some(d => d.date === date)) return toast(`${shortDate(date, today)} is in the list already.`)
    setDays(withDays(days, [{ date, name: name.trim(), start: null, end: null }]))
    setDate('')
    setName('')
  }
  function remove(day: ClosedDay) {
    setDays(days.filter(d => d.date !== day.date))
    toast(`Removed ${day.name || shortDate(day.date, today)}.`)
  }
  return (
    <Section
      id="as-holidays"
      title="Holidays and closures"
      description="Days you are closed, whatever the weekly hours say."
      help="On these days the assistant tells callers you are closed and when you open again, and books no appointments. It also mentions holidays in the next two weeks when callers ask about your hours."
    >
      {!loaded ? null : upcoming.length ? (
        <List label="Holidays and closures">
          {upcoming.map(d => (
            <ListRow
              key={d.date}
              title={d.name || shortDate(d.date, today)}
              sub={d.name ? shortDate(d.date, today) : undefined}
              aside={<span className="help">{dayHoursLabel(d)}</span>}
              actions={
                canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="st-rm"
                    aria-label={`Remove ${d.name || d.date}`}
                    title="Remove"
                    onClick={() => remove(d)}
                  />
                )
              }
            />
          ))}
        </List>
      ) : (
        <ListEmpty>{hoursOn ? 'No holidays yet: the weekly hours apply every day.' : 'No holidays yet.'}</ListEmpty>
      )}
      {canEdit && (
        <form className="st-inline hd-add" onSubmit={add}>
          <Input type="date" value={date} min={today} onChange={e => setDate(e.target.value)} aria-label="Day" className="hd-date" />
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Staff training" aria-label="Name" maxLength={80} />
          <Button size="sm" type="submit" disabled={!date}>
            Add day
          </Button>
        </form>
      )}
    </Section>
  )
}

/** Vacation or closure mode: off, being set up, or on (scheduled, running or ended) with Edit and Turn off. */
export function VacationMode({ canEdit, toast }: Props) {
  const { loaded, today, closure, setClosure } = useClosedDays()
  const [draft, setDraft] = useState<Closure | null>(null)
  const active = closure && closureState(closure, today) !== 'ended' ? closure : null
  function start() {
    const until = addDays(today, 6)
    setDraft(closure && closureState(closure, today) !== 'ended' ? closure : { from: today, until, greeting: defaultClosureGreeting(until) })
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
              <Input id="hd-from" type="date" value={draft.from} min={today} onChange={e => setDraft({ ...draft, from: e.target.value })} />
            </Field>
            <Field id="hd-until" label="Last day closed">
              <Input id="hd-until" type="date" value={draft.until} min={draft.from || today} onChange={e => setUntil(e.target.value)} />
            </Field>
          </div>
          <Field id="hd-greeting" label="Greeting while closed" aside="Optional">
            <TextArea id="hd-greeting" value={draft.greeting} onChange={greeting => setDraft({ ...draft, greeting })} placeholder="Empty: the outside-hours greeting" />
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
