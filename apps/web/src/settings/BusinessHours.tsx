// Settings › Assistant, Business hours (optional): when the office is open, per weekday. The voice
// agent gets them with each call, so outside them the assistant can say the office is closed, take a
// message and say when someone calls back. Part of the Assistant page's one draft: its Save runs
// businessHours.set when the hours changed.
import type { BusinessHoursSpan, WorkspaceSettingsData } from '@callfront/actions'
import { useEffect, useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
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
} from './businessHoursModel.ts'
import { readAction } from './settings-api.ts'

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const startOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '24:00')
const endOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '00:00')

/** The hours as part of a page draft: loaded once, edited locally, saved with the rest of the page. */
export type HoursDraft = ReturnType<typeof useBusinessHours>

export function useBusinessHours() {
  const run = useRun()
  const [saved, setSaved] = useState<BusinessHoursSpan[] | null>(null)
  const [days, setDays] = useState<DayHours[]>([])
  const [timeZone, setTimeZone] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    readAction<WorkspaceSettingsData>('workspace.getSettings').then(
      data => {
        setSaved(data.businessHours)
        setDays(dayRows(data.businessHours))
        setTimeZone(data.timeZone)
      },
      (e: Error) => setLoadError(e.message),
    )
  }, [])
  const dirty = saved !== null && hoursChanged(saved, days)
  return {
    saved,
    days,
    timeZone,
    loadError,
    dirty,
    problem: dirty ? hoursProblem(days) : null,
    set: (weekday: number, change: Partial<DayHours>) =>
      setDays(all => all.map(d => (d.weekday === weekday ? { ...d, ...change } : d))),
    clear: () => setDays(dayRows([])),
    discard: () => saved && setDays(dayRows(saved)),
    /** Runs businessHours.set when the hours changed; call only when `problem` is null. */
    save: () => {
      if (!dirty) return
      const hours = spansOf(days)
      void run('businessHours.set', { hours })
      setSaved(hours)
      setDays(dayRows(hours))
    },
  }
}

type Props = { hours: HoursDraft; canEdit: boolean; name: string }

export function BusinessHours({ hours, canEdit, name }: Props) {
  const { saved, days, timeZone, loadError, problem, set } = hours
  function toggle(weekday: number, open: boolean) {
    // A day that opens takes the hours of the day before it, else 8:00 AM–5:00 PM.
    const before = [...days].reverse().find(d => d.open && d.weekday !== weekday)
    set(
      weekday,
      open ? { open, start: before?.start ?? DEFAULT_SPAN.start, end: before?.end ?? DEFAULT_SPAN.end } : { open },
    )
  }

  const description = `Optional. Outside them, ${name} takes a message.`
  const help = `Outside these hours ${name} tells callers the office is closed, takes a message and says when someone will call back.`
  if (!saved)
    return (
      <Section id="as-hours" title="Business hours" description={description} help={help}>
        <p className="help" role={loadError ? 'alert' : undefined}>
          {loadError ?? 'Loading…'}
        </p>
      </Section>
    )
  return (
    <Section id="as-hours" title="Business hours" description={description} help={help}>
      <div className="st-list" role="group" aria-label="Opening hours by day">
        {WEEK_ORDER.map(weekday => {
          const day = days.find(d => d.weekday === weekday)!
          return (
            <div key={weekday} className="st-li st-day">
              <b>{DAY[weekday]}</b>
              <Switch
                on={day.open}
                onChange={open => toggle(weekday, open)}
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
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <div className="st-hours-foot">
        <span className="help">{timeZone ? `Times in ${timeZone.replaceAll('_', ' ')}.` : ''}</span>
        {canEdit && days.some(d => d.open) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={hours.clear}
            title="Close every day: the assistant then says nothing about opening times. Saved with Save."
          >
            Clear hours
          </Button>
        )}
      </div>
    </Section>
  )
}
