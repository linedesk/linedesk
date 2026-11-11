// Step 3: when the business is open, and the time zone those hours are in (confirmed, not taken silently).
import type { WorkspaceSettingsData } from '@linedesk/actions'
import { useState } from 'react'
import { HoursGrid, TimeZoneSelect } from '../settings/BusinessHours.tsx'
import { type DayHours, hoursProblem, spansOf } from '../settings/businessHoursModel.ts'
import { Field } from '../settings/fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from '../settings/settings-api.ts'
import { browserTimeZone } from '../settings/timeZones.ts'
import { useAssistantName, useRun } from '../store.tsx'
import { Switch } from '../ui/controls.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import { firstHoursDraft } from './flow.ts'

type StepProps = { onBack: () => void; onNext: () => void }

export function HoursStep({ onBack, onNext }: StepProps) {
  const settings = useWorkspaceSettings()
  const name = useAssistantName()
  if (settings.data) return <HoursForm saved={settings.data} onBack={onBack} onNext={onNext} />
  // Until the saved hours arrive: the form's frame with Continue not yet usable. Skipping is offered
  // only when they could not be loaded.
  return (
    <>
      <div className="ob-body">
        <h1>When are you open?</h1>
        <p className="ob-lede">{name} tells callers when you're open.</p>
        {settings.error ? (
          <LoadProblem what="Business hours" message={settings.error} onRetry={() => void settings.reload()} />
        ) : (
          <SkeletonRows label="Loading business hours" rows={5} />
        )}
      </div>
      {settings.error ? (
        <Foot onBack={onBack} onContinue={onNext} canContinue label="Skip for now" />
      ) : (
        <Foot onBack={onBack} onContinue={onNext} canContinue={false} />
      )}
    </>
  )
}

function HoursForm({ saved, onBack, onNext }: StepProps & { saved: WorkspaceSettingsData }) {
  const run = useRun()
  const name = useAssistantName()
  const [first] = useState(() => firstHoursDraft(saved, browserTimeZone()))
  const [on, setOn] = useState(first.on)
  const [days, setDays] = useState<DayHours[]>(first.days)
  const [timeZone, setTimeZone] = useState(first.timeZone)
  const problem = on ? hoursProblem(days) : null

  function next() {
    if (problem) return
    const hours = spansOf(days)
    if (on) void run('businessHours.set', { hours })
    void run('workspace.updateSettings', { businessHoursOn: on, timeZone })
    patchWorkspaceSettings({ businessHoursOn: on, timeZone, ...(on ? { businessHours: hours } : {}) })
    onNext()
  }
  useStepKeys({ onEnter: next, onEscape: onBack })

  const set = (weekday: number, change: Partial<DayHours>) =>
    setDays(all => all.map(d => (d.weekday === weekday ? { ...d, ...change } : d)))
  return (
    <>
      <div className="ob-body">
        <h1>When are you open?</h1>
        <p className="ob-lede">{name} tells callers when you're open.</p>
        <Field id="ob-tz" label="Time zone">
          <TimeZoneSelect id="ob-tz" value={timeZone} onChange={setTimeZone} />
        </Field>
        <div className="ob-hours-head">
          <span className="ob-label">Business hours</span>
          <Switch on={on} onChange={setOn} label="Use business hours" />
        </div>
        {on ? (
          <HoursGrid days={days} set={set} canEdit />
        ) : (
          <p className="ob2-note">Off: {name} says nothing about opening hours.</p>
        )}
        {problem && (
          <p className="ob-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      <Foot onBack={onBack} onContinue={next} canContinue={!problem} />
    </>
  )
}
