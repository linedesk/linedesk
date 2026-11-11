// Business hours, opt-in and workspace-wide. Turned on, the weekly hours reach the voice agent with each
// call (open now or not, when that changes) and the greeting may have an outside-hours variant. Off, the
// assistant says nothing about hours. Edited in BusinessHoursDialog (its grid and time zone are here);
// Assistant › Hours & holidays shows them in one line.
import { useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Section } from './fields.tsx'
import {
  type DayHours,
  dayRows,
  DEFAULT_SPAN,
  hoursChanged,
  hoursProblem,
  spansOf,
  timeOptions,
  WEEK_ORDER,
  weekSummary,
} from './businessHoursModel.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { timeZoneLabel, timeZoneOptions } from './timeZones.ts'

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const startOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '24:00')
const endOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '00:00')

/** The hours as part of a page draft: loaded once, edited locally, saved with the rest of the page. */
export type HoursDraft = ReturnType<typeof useBusinessHours>

export function useBusinessHours() {
  const run = useRun()
  const settings = useWorkspaceSettings()
  const saved = settings.data?.businessHours ?? null
  // The edited grid; null while it matches what is saved (then a fresh answer shows as it arrives).
  const [draft, setDraft] = useState<DayHours[] | null>(null)
  const days = draft ?? dayRows(saved ?? [])
  const dirty = draft !== null && saved !== null && hoursChanged(saved, draft)
  const edit = (change: (current: DayHours[]) => DayHours[]) => setDraft(change(days))
  return {
    saved,
    days,
    timeZone: settings.data?.timeZone ?? '',
    on: settings.data?.businessHoursOn ?? false,
    /** Turns business hours on or off for the workspace, at once. */
    setOn: (next: boolean) => {
      patchWorkspaceSettings({ businessHoursOn: next })
      void run('workspace.updateSettings', { businessHoursOn: next })
    },
    loadError: settings.data ? null : settings.error,
    retry: settings.reload,
    dirty,
    problem: dirty ? hoursProblem(days) : null,
    set: (weekday: number, change: Partial<DayHours>) =>
      edit(all => all.map(d => (d.weekday === weekday ? { ...d, ...change } : d))),
    clear: () => edit(() => dayRows([])),
    discard: () => setDraft(null),
    /** Runs businessHours.set when the hours changed; call only when `problem` is null. */
    save: () => {
      if (!dirty) return
      const hours = spansOf(days)
      void run('businessHours.set', { hours })
      patchWorkspaceSettings({ businessHours: hours })
      setDraft(null)
    },
  }
}

/** Opens or closes a day. A day that opens takes the hours of the day before it, else 8:00 AM–5:00 PM. */
function openChange(days: readonly DayHours[], weekday: number, open: boolean): Partial<DayHours> {
  if (!open) return { open }
  const before = [...days].reverse().find(d => d.open && d.weekday !== weekday)
  return { open, start: before?.start ?? DEFAULT_SPAN.start, end: before?.end ?? DEFAULT_SPAN.end }
}

type GridProps = {
  days: readonly DayHours[]
  set: (weekday: number, change: Partial<DayHours>) => void
  canEdit: boolean
}

/** The week, Monday first: a switch per day and its opening and closing time. Used in Settings and onboarding. */
export function HoursGrid({ days, set, canEdit }: GridProps) {
  return (
    <div className="st-list" role="group" aria-label="Opening hours by day">
      {WEEK_ORDER.map(weekday => {
        const day = days.find(d => d.weekday === weekday)!
        return (
          <div key={weekday} className="st-li st-day">
            <b>{DAY[weekday]}</b>
            <Switch
              on={day.open}
              onChange={open => set(weekday, openChange(days, weekday, open))}
              label={`Open on ${DAY[weekday]}`}
              disabled={!canEdit}
            />
            {day.open ? (
              <span className="st-times">
                <Select
                  size="sm"
                  value={day.start}
                  options={startOptions}
                  onChange={start => set(weekday, { start })}
                  label={`${DAY[weekday]} opens`}
                  disabled={!canEdit}
                />
                <span className="help">to</span>
                <Select
                  size="sm"
                  value={day.end}
                  options={endOptions}
                  onChange={end => set(weekday, { end })}
                  label={`${DAY[weekday]} closes`}
                  disabled={!canEdit}
                />
              </span>
            ) : (
              <span className="help">Closed</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The workspace's time zone as a picker; typing a city's first letters jumps to it. */
export function TimeZoneSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string
  onChange: (zone: string) => void
  disabled?: boolean
  id?: string
}) {
  return (
    <Select
      id={id}
      size="sm"
      value={value}
      options={timeZoneOptions(value)}
      onChange={onChange}
      label="Time zone"
      disabled={disabled}
    />
  )
}

/**
 * Assistant › Hours & holidays: the weekly hours in one line and whether they are used; "Edit business hours"
 * opens the same editor as everywhere else that depends on them (BusinessHoursDialog).
 */
export function BusinessHours({ canEdit }: { canEdit: boolean }) {
  const hours = useBusinessHours()
  const { saved, days, timeZone, loadError, on } = hours
  return (
    <Section
      id="st-hours"
      title="Business hours"
      description={on ? undefined : 'Off'}
      help="Your assistant tells callers when you are open and, when you are closed, when to expect a call back. Appointments are only booked inside these hours unless a type says otherwise, and the greeting can be different outside them."
      actions={<EditBusinessHours canEdit={canEdit} variant="button" label={on ? 'Edit business hours' : 'Set business hours'} />}
    >
      {!saved ? (
        loadError ? (
          <LoadProblem what="Business hours" message={loadError} onRetry={() => void hours.retry()} />
        ) : (
          <SkeletonRows label="Loading business hours" rows={1} />
        )
      ) : on ? (
        <p className="bh-summary">
          {weekSummary(days)}
          <span className="help"> · {timeZoneLabel(timeZone)}</span>
        </p>
      ) : (
        <p className="help">Not used: bookings use Monday to Friday, 9 to 5, and greetings and transfers do not depend on the time.</p>
      )}
    </Section>
  )
}
