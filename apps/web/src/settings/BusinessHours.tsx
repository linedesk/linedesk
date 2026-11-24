// Business hours, opt-in and workspace-wide. Turned on, the weekly hours reach the voice agent with each
// call (open now or not, when that changes) and the greeting may have an outside-hours variant. Off, the
// assistant says nothing about hours. Edited in BusinessHoursDialog (its grid and time zone are here);
// Assistant › Hours & holidays shows them in one line.
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, Switch } from '../ui/controls.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { Section } from './fields.tsx'
import {
  type DayHours,
  dayRows,
  DEFAULT_SPAN,
  endTimeOptions,
  hoursChanged,
  hoursProblem,
  spansOf,
  startTimeOptions,
  WEEK_ORDER,
  weekdayName,
  weekSummary,
} from './businessHoursModel.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { TimeZonePicker } from './TimeZonePicker.tsx'
import { timeZoneLabel } from './timeZones.ts'

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
  const t = useT()
  const startOptions = startTimeOptions()
  const endOptions = endTimeOptions()
  return (
    <div className="st-list" role="group" aria-label={t('settings.hours.byDay')}>
      {WEEK_ORDER.map(weekday => {
        const day = days.find(d => d.weekday === weekday)!
        const name = weekdayName(weekday)
        return (
          <div key={weekday} className="st-li st-day">
            <b>{name}</b>
            <Switch
              on={day.open}
              onChange={open => set(weekday, openChange(days, weekday, open))}
              label={t('settings.hours.openOn', { day: name })}
              disabled={!canEdit}
            />
            {day.open ? (
              <span className="st-times">
                <Select
                  size="sm"
                  value={day.start}
                  options={startOptions}
                  onChange={start => set(weekday, { start })}
                  label={t('settings.hours.dayOpens', { day: name })}
                  disabled={!canEdit}
                />
                <span className="help">{t('settings.hours.to')}</span>
                <Select
                  size="sm"
                  value={day.end}
                  options={endOptions}
                  onChange={end => set(weekday, { end })}
                  label={t('settings.hours.dayCloses', { day: name })}
                  disabled={!canEdit}
                />
              </span>
            ) : (
              <span className="help">{t('settings.hours.closed')}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The workspace's time zone as a searchable picker, with each zone's GMT offset and time now (TimeZonePicker). */
export function TimeZoneSelect({
  value,
  onChange,
  disabled,
  id,
  countryDefault,
}: {
  value: string
  onChange: (zone: string) => void
  disabled?: boolean
  id?: string
  /** The workspace country's zone, marked "(country default)" in the list and on the button. */
  countryDefault?: string | null
}) {
  return (
    <TimeZonePicker id={id} value={value} onChange={onChange} disabled={disabled} countryDefault={countryDefault} />
  )
}

/**
 * Assistant › Hours & holidays: the weekly hours in one line and whether they are used; "Edit business hours"
 * opens the same editor as everywhere else that depends on them (BusinessHoursDialog).
 */
export function BusinessHours({ canEdit }: { canEdit: boolean }) {
  const t = useT()
  const hours = useBusinessHours()
  const { saved, days, timeZone, loadError, on } = hours
  return (
    <Section
      id="st-hours"
      title={t('settings.hours.title')}
      description={on ? undefined : t('settings.hours.off')}
      help={t('settings.hours.help')}
      actions={
        <EditBusinessHours
          canEdit={canEdit}
          variant="button"
          label={on ? t('settings.hours.edit') : t('settings.hours.set')}
        />
      }
    >
      <Loading
        what={t('settings.hours.title')}
        loading={!saved}
        error={loadError}
        onRetry={() => void hours.retry()}
        skeleton={
          <>
            <Skeleton shape="text" width={300} />
            <Skeleton shape="text" width={190} />
          </>
        }
      >
        {/* Off: only "Off" and its button (LIN-692); the week and the time zone matter once hours are used. */}
        {on && <p className="bh-summary">{weekSummary(days)}</p>}
        {on && timeZone && <TimeZoneLine zone={timeZone} canEdit={canEdit} />}
      </Loading>
    </Section>
  )
}

/** The workspace's time zone in one quiet line; it is set in Workspace settings › General. */
function TimeZoneLine({ zone, canEdit }: { zone: string; canEdit: boolean }) {
  const t = useT()
  return (
    <p className="help bh-zone">
      {canEdit ? (
        <T
          k="settings.hours.timeZoneChange"
          values={{
            zone: timeZoneLabel(zone),
            link: appLink('#workspace/general'),
          }}
        />
      ) : (
        t('settings.hours.timeZone', { zone: timeZoneLabel(zone) })
      )}
    </p>
  )
}
