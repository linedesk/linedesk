// Settings, Business hours: opt-in and workspace-wide. Turned on, the weekly hours reach the voice
// agent with each call (open now or not, when that changes) and greeting and instructions may have an
// outside-hours variant. Off, the assistant says nothing about hours. The switch saves at once; the
// weekly grid is a draft with Cancel / Save (⌘S).
import { type FormEvent, useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { onSaveKey, SaveBar } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
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
} from './businessHoursModel.ts'
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

type Props = { canEdit: boolean; toast: (text: string) => void }

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

/** The Business hours section of Settings: the main switch, and the weekly grid while it is on. */
export function BusinessHours({ canEdit, toast }: Props) {
  const run = useRun()
  const hours = useBusinessHours()
  const { saved, days, timeZone, loadError, problem, set, on, dirty } = hours
  function save(e: FormEvent) {
    e.preventDefault()
    if (problem) return toast(problem)
    hours.save()
    toast('Business hours saved.')
  }
  // The time zone saves at once, like the switch: it is one choice, not part of the grid's draft.
  function changeTimeZone(zone: string) {
    patchWorkspaceSettings({ timeZone: zone })
    void run('workspace.updateSettings', { timeZone: zone })
    toast(`Time zone set to ${timeZoneLabel(zone)}.`)
  }

  const help = 'The assistant tells callers when you are open. Greeting and instructions can differ outside hours.'
  const mainSwitch = (
    <span className="bh-main">
      <span className="help">Use business hours</span>
      <Switch on={on} onChange={hours.setOn} label="Use business hours" disabled={!canEdit || !saved} />
    </span>
  )
  if (!saved)
    return (
      <Section id="st-hours" title="Business hours" help={help} actions={mainSwitch}>
        {loadError ? (
          <LoadProblem what="Business hours" message={loadError} onRetry={() => void hours.retry()} />
        ) : (
          <SkeletonRows label="Loading business hours" rows={3} />
        )}
      </Section>
    )
  return (
    <form onSubmit={save} onKeyDown={e => onSaveKey(e, canEdit && dirty)}>
      <Section
        id="st-hours"
        title="Business hours"
        description={on ? undefined : 'Off'}
        help={help}
        actions={mainSwitch}
      >
        {on && (
          <>
            <HoursGrid days={days} set={set} canEdit={canEdit} />
            {problem && (
              <p className="field-error" role="alert">
                {problem}
              </p>
            )}
            <div className="st-hours-foot">
              <span className="st-tz">
                <span className="help">Times in</span>
                <TimeZoneSelect value={timeZone} onChange={changeTimeZone} disabled={!canEdit} />
              </span>
              {canEdit && days.some(d => d.open) && (
                <Button size="sm" variant="ghost" onClick={hours.clear} title="Close every day">
                  Clear hours
                </Button>
              )}
            </div>
          </>
        )}
      </Section>
      {canEdit && <SaveBar dirty={dirty} onCancel={hours.discard} />}
    </form>
  )
}
