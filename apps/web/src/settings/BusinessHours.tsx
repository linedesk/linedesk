// Settings › Assistant, Business hours (optional): when the office is open, per weekday. The voice
// agent gets them with each call, so outside them the assistant can say the office is closed, take a
// message and say when someone calls back. Saved as a whole with businessHours.set.
import type { BusinessHoursSpan, WorkspaceSettingsData } from '@callfront/actions'
import { useEffect, useState } from 'react'
import { useAssistantName, useRun } from '../store.tsx'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
import { Section } from './fields.tsx'
import {
  type DayHours,
  dayRows,
  DEFAULT_SPAN,
  hoursChanged,
  spansOf,
  timeOptions,
  WEEK_ORDER,
} from './businessHoursModel.ts'
import { readAction } from './settings-api.ts'

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const startOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '24:00')
const endOptions: SelectOption<string>[] = timeOptions.filter(o => o.value !== '00:00')

type Props = { canEdit: boolean; toast: (text: string) => void }

export function BusinessHours({ canEdit, toast }: Props) {
  const run = useRun()
  const name = useAssistantName()
  const [saved, setSaved] = useState<BusinessHoursSpan[] | null>(null)
  const [days, setDays] = useState<DayHours[]>([])
  const [timeZone, setTimeZone] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    readAction<WorkspaceSettingsData>('workspace.getSettings').then(
      data => {
        setSaved(data.businessHours)
        setDays(dayRows(data.businessHours))
        setTimeZone(data.timeZone)
      },
      (e: Error) => setError(e.message),
    )
  }, [])

  const set = (weekday: number, change: Partial<DayHours>) =>
    setDays(all => all.map(d => (d.weekday === weekday ? { ...d, ...change } : d)))
  function toggle(weekday: number, open: boolean) {
    // A day that opens takes the hours of the day before it, else 8:00 AM–5:00 PM.
    const before = [...days].reverse().find(d => d.open && d.weekday !== weekday)
    set(
      weekday,
      open ? { open, start: before?.start ?? DEFAULT_SPAN.start, end: before?.end ?? DEFAULT_SPAN.end } : { open },
    )
  }
  function save(next: DayHours[]) {
    const hours = spansOf(next)
    if (hours.some(h => h.end <= h.start)) return setError('Each open day needs a closing time after its opening time.')
    setError(null)
    void run('businessHours.set', { hours })
    setSaved(hours)
    setDays(dayRows(hours))
    toast(hours.length ? 'Business hours saved.' : 'Business hours cleared.')
  }

  const description = `Optional. Outside these hours ${name} tells callers the office is closed, takes a message and says when someone will call back.`
  if (error && !saved)
    return (
      <Section id="as-hours" title="Business hours" description={description}>
        <p className="help" role="alert">
          {error}
        </p>
      </Section>
    )
  if (!saved)
    return (
      <Section id="as-hours" title="Business hours" description={description}>
        <p className="help">Loading…</p>
      </Section>
    )
  const dirty = hoursChanged(saved, days)
  return (
    <Section id="as-hours" title="Business hours" description={description}>
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
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="st-hours-foot">
        <span className="help">{timeZone ? `Times in ${timeZone.replaceAll('_', ' ')}.` : ''}</span>
        {canEdit && saved.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => save(dayRows([]))}
            title="Remove all hours: the assistant then says nothing about opening times"
          >
            Clear hours
          </Button>
        )}
        {canEdit && dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDays(dayRows(saved))}>
            Discard
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => save(days)}>
            Save hours
          </Button>
        )}
      </div>
    </Section>
  )
}
