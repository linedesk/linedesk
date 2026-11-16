// Settings > Assistant > Hours & holidays, below the weekly hours: the days the business is closed, and
// vacation or closure mode (a date range with its own greeting). Workspace-wide like the hours.
//
// Closed days come from three places, shown together in "Next closed days": the public holiday calendar the
// workspace follows (country and state; every year, less the holidays it is open on), its own days (closed
// all day or shorter hours, once or every year), and single dates changed for this year (open, or shorter
// hours). The server keeps the next twelve months written (holidays.set, closedDays.set, public-holidays.ts).
import type { ClosedDay, HolidayLookupData, WorkspaceSettingsData } from '@linedesk/actions'
import type { Closure, HolidayCalendar } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useState } from 'react'
import { useRun } from '../store.tsx'
import { Checkbox, Select, Switch } from '../ui/controls.tsx'
import { DateInput, Dialog, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow, MenuButton, type MenuItem } from '../ui/list.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { endTimeOptions, startTimeOptions } from './businessHoursModel.ts'
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

/**
 * The workspace's closed days and closure: what is saved, and how to change it. A change shows at once (as far
 * as the browser can tell), then the server's answer, which knows the holidays, replaces it.
 */
export function useClosedDays(toast?: (text: string) => void) {
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
  const t = useT()
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
      ? { id: 'closed', label: t('settings.holidays.menu.closedAllDay'), onSelect: () => setHours(day, null) }
      : { id: 'hours', label: t('settings.holidays.menu.shorterHours'), onSelect: () => setEditing(day.date) }
    if (day.kind === 'own') {
      return [
        hours,
        day.yearly
          ? {
              id: 'once',
              label: t('settings.holidays.menu.onlyThisYear'),
              onSelect: () => setOwn(own.map(d => (d.date === day.date ? { ...d, yearly: false } : d))),
            }
          : {
              id: 'yearly',
              label: t('settings.holidays.everyYear'),
              onSelect: () => setOwn(own.map(d => (d.date === day.date ? { ...d, yearly: true } : d))),
            },
        {
          id: 'remove',
          label: day.yearly ? t('settings.holidays.menu.removeEveryYear') : t('settings.holidays.menu.remove'),
          danger: true,
          onSelect: () => {
            setOwn(own.filter(d => d.date !== day.date))
            toast(t('settings.holidays.toast.removed', { label }))
          },
        },
      ]
    }
    const openThisYear: MenuItem = {
      id: 'open',
      label: t('settings.holidays.openThisYear'),
      onSelect: () => {
        setCalendar(
          withChange(calendarOrOff(), day.date, { date: day.date, name: day.name, open: true, start: null, end: null }),
        )
        toast(t('settings.holidays.toast.openThisYear', { label }))
      },
    }
    if (day.kind === 'holiday' && calendar) {
      return [
        openThisYear,
        {
          id: 'always',
          label: t('settings.holidays.menu.openEveryYear', { name: day.key }),
          onSelect: () => {
            setCalendar({
              ...calendar,
              off: [...calendar.off, day.key],
              changes: calendar.changes.filter(c => c.date !== day.date),
            })
            toast(t('settings.holidays.toast.openEveryYear', { name: day.key }))
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
        label: t('settings.holidays.menu.removeEveryYear'),
        danger: true,
        onSelect: () => {
          setOwn(own.filter(d => d.date !== day.key))
          toast(t('settings.holidays.toast.removedEveryYear', { label }))
        },
      },
    ]
  }

  function sub(day: UpcomingDay) {
    const from = {
      own: day.yearly ? t('settings.holidays.everyYear') : t('settings.holidays.yourDay'),
      holiday: t('settings.holidays.publicHoliday'),
      repeat: t('settings.holidays.everyYear'),
      opened: t('settings.holidays.openThisYear'),
    }[day.kind]
    const date = shortDate(day.date, today)
    return day.changed && day.kind !== 'opened'
      ? t('settings.holidays.subChanged', { date, from })
      : t('settings.holidays.sub', { date, from })
  }

  return (
    <Section
      id="as-holidays"
      title={t('settings.holidays.title')}
      description={t('settings.holidays.description')}
      help={t('settings.holidays.help')}
    >
      <Loading
        what={t('settings.holidays.publicHolidays')}
        loading={!loaded}
        skeleton={<SkeletonList rows={1} action />}
      >
        <List label={t('settings.holidays.publicHolidays')} className="hd-calendar">
          <CalendarRow
            calendar={calendar}
            canEdit={canEdit}
            onChoose={() => setChoosing(true)}
            onToggle={on => calendar && setCalendar({ ...calendar, on })}
          />
        </List>
      </Loading>
      {choosing && (
        <CalendarDialog
          calendar={calendar}
          today={today}
          onClose={() => setChoosing(false)}
          onSave={next => {
            setCalendar(next)
            setChoosing(false)
            toast(calendar ? t('settings.holidays.toast.saved') : t('settings.holidays.toast.on'))
          }}
        />
      )}
      <h3 className="hd-heading">{t('settings.holidays.next')}</h3>
      <Loading
        what={t('settings.holidays.closedDays')}
        loading={!loaded}
        skeleton={<SkeletonList rows={2} aside action />}
      >
        {days.length ? (
          <>
            <List label={t('settings.holidays.next')}>
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
                        {t('settings.holidays.closeAgain')}
                      </Button>
                    ) : (
                      <MenuButton
                        title={t('settings.holidays.moreFor', { name: d.name || shortDate(d.date, today) })}
                        items={itemsFor(d)}
                      />
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
                {all ? t('settings.holidays.showFewer') : t('settings.holidays.showAll', { count: days.length })}
              </Button>
            )}
          </>
        ) : (
          <ListEmpty>{hoursOn ? t('settings.holidays.emptyWithHours') : t('settings.holidays.empty')}</ListEmpty>
        )}
      </Loading>
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
  const t = useT()
  const names = usePlaceNames(calendar)
  if (!calendar) {
    return (
      <ListRow
        title={t('settings.holidays.publicHolidays')}
        sub={t('settings.holidays.calendar.notSet')}
        actions={
          canEdit && (
            <Button size="sm" icon="calendar" onClick={onChoose}>
              {t('settings.holidays.calendar.choose')}
            </Button>
          )
        }
      />
    )
  }
  return (
    <ListRow
      off={!calendar.on}
      title={t('settings.holidays.publicHolidays')}
      sub={
        calendar.on
          ? names
            ? calendarSummary(calendar, names.country, names.state)
            : '…'
          : t('settings.holidays.calendar.off')
      }
      actions={
        <>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={onChoose}>
              {t('common.action.change')}
            </Button>
          )}
          <Switch
            on={calendar.on}
            onChange={onToggle}
            label={t('settings.holidays.publicHolidays')}
            disabled={!canEdit}
          />
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
  const t = useT()
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('12:00')
  return (
    <div className="hd-hours">
      <Select
        size="sm"
        label={t('settings.holidays.opens')}
        value={start}
        options={startTimeOptions()}
        onChange={setStart}
      />
      <span className="help">{t('settings.hours.to')}</span>
      <Select
        size="sm"
        label={t('settings.holidays.closes')}
        value={end}
        options={endTimeOptions()}
        onChange={setEnd}
      />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {t('common.action.cancel')}
      </Button>
      <Button size="sm" variant="primary" disabled={end <= start} onClick={() => onSave({ start, end })}>
        {t('settings.holidays.saveHours')}
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
  const t = useT()
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [yearly, setYearly] = useState(false)
  function add(e: FormEvent) {
    e.preventDefault()
    if (!date || date < today) return toast(t('settings.holidays.add.pickFromToday'))
    if (own.some(d => d.date === date))
      return toast(t('settings.holidays.add.already', { date: shortDate(date, today) }))
    onAdd({ date, name: name.trim(), start: null, end: null, yearly })
    setDate('')
    setName('')
    setYearly(false)
  }
  return (
    <form className="st-inline hd-add" onSubmit={add}>
      <DateInput
        value={date}
        min={today}
        onChange={setDate}
        aria-label={t('settings.holidays.add.day')}
        className="hd-date"
      />
      <Input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={t('settings.holidays.add.namePlaceholder')}
        aria-label={t('settings.holidays.add.name')}
        maxLength={80}
      />
      <Checkbox checked={yearly} onChange={setYearly} className="hd-yearly">
        {t('settings.holidays.everyYear')}
      </Checkbox>
      <Button type="submit" disabled={!date}>
        {t('settings.holidays.add.button')}
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
 * Which public holidays close the business: a country (first the saved one, else the workspace country, else its time zone's)
 * and a state, and its holidays of the next twelve months, checked unless the business is open on them every
 * year. Unchecked holidays stay unchecked in later years too.
 */
function CalendarDialog({ calendar, today, onClose, onSave }: CalendarDialogProps) {
  const t = useT()
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
      title={t('settings.holidays.publicHolidays')}
      description={t('settings.holidays.calendar.description')}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.action.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={loading || !data}
            title={t('common.action.saveWithKey', { key: '⌘S' })}
          >
            {calendar?.on ? t('common.action.save') : t('settings.holidays.calendar.closeOn', { count: closedCount })}
          </Button>
        </>
      }
    >
      {data && (
        <div className="hd-place">
          <Field id="hd-country" label={t('settings.holidays.calendar.country')}>
            <Select
              id="hd-country"
              label={t('settings.holidays.calendar.country')}
              value={data.country}
              options={data.countries.map(c => ({ value: c.code, label: c.name }))}
              onChange={country => setPlace({ country })}
            />
          </Field>
          {data.states.length > 0 && (
            <Field id="hd-state" label={t('settings.holidays.calendar.state')}>
              <Select
                id="hd-state"
                label={t('settings.holidays.calendar.state')}
                value={data.state ?? ''}
                options={[
                  { value: '', label: t('settings.holidays.calendar.nationwideOnly') },
                  ...data.states.map(s => ({ value: s.code, label: s.name })),
                ]}
                onChange={state => setPlace({ country: data.country, state: state || undefined })}
              />
            </Field>
          )}
        </div>
      )}
      <Loading
        what={t('settings.holidays.publicHolidays')}
        loading={!data || Boolean(error)}
        error={error}
        onRetry={() => setPlace(p => ({ ...p }))}
        skeleton={<SkeletonList rows={6} sub={false} aside />}
      >
        {data?.holidays.length ? (
          <List label={t('settings.holidays.publicHolidays')}>
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
          <ListEmpty>{t('settings.holidays.calendar.empty')}</ListEmpty>
        )}
      </Loading>
    </Dialog>
  )
}

/** Vacation or closure mode: off, being set up, or on (scheduled, running or ended) with Edit and Turn off. */
export function VacationMode({ canEdit, toast }: Props) {
  const t = useT()
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
    toast(
      closureState(draft, today) === 'on'
        ? t('settings.holidays.vacation.toastOn')
        : t('settings.holidays.vacation.toastScheduled'),
    )
  }
  function turnOff() {
    setClosure(null)
    setDraft(null)
    toast(t('settings.holidays.vacation.toastOff'))
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
      title={t('settings.holidays.vacation.title')}
      description={active ? closureSummary(active, today) : t('settings.holidays.vacation.description')}
      help={t('settings.holidays.vacation.help')}
      actions={
        <Switch
          on={on}
          onChange={next => (next ? start() : active ? turnOff() : setDraft(null))}
          label={t('settings.holidays.vacation.title')}
          disabled={!canEdit || !loaded}
        />
      }
    >
      {draft ? (
        <form className="hd-vac" onSubmit={save}>
          <div className="hd-range">
            <Field id="hd-from" label={t('settings.holidays.vacation.from')}>
              <DateInput id="hd-from" value={draft.from} min={today} onChange={from => setDraft({ ...draft, from })} />
            </Field>
            <Field id="hd-until" label={t('settings.holidays.vacation.until')}>
              <DateInput id="hd-until" value={draft.until} min={draft.from || today} onChange={setUntil} />
            </Field>
          </div>
          <Field
            id="hd-greeting"
            label={t('settings.holidays.vacation.greeting')}
            aside={t('settings.holidays.vacation.optional')}
          >
            <TextArea
              id="hd-greeting"
              value={draft.greeting}
              onChange={greeting => setDraft({ ...draft, greeting })}
              placeholder={t('settings.holidays.vacation.greetingPlaceholder')}
            />
          </Field>
          <div className="hd-actions">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t('common.action.cancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit">
              {active ? t('common.action.save') : t('settings.holidays.vacation.turnOn')}
            </Button>
          </div>
        </form>
      ) : active ? (
        <div className="hd-on">
          <p className="hd-quote">
            {t('settings.holidays.vacation.quote', {
              greeting: active.greeting || t('settings.holidays.vacation.outsideHoursGreeting'),
            })}
          </p>
          <span className="help">{t('settings.holidays.vacation.onNote')}</span>
          {canEdit && (
            <div className="hd-actions">
              <Button size="sm" variant="ghost" onClick={turnOff}>
                {t('settings.holidays.vacation.turnOff')}
              </Button>
              <Button size="sm" onClick={start}>
                {t('settings.holidays.vacation.edit')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Section>
  )
}
