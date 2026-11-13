// Step 3, "When should Maya pick up?": when the business can't answer (the default), only when it is closed,
// or every call. Business hours are asked only for "only when we're closed". The choice picks the forwarding
// code on the phone step; routing stays with the number's mode and the hours (no new call routing).
import type { PickupMode, WorkspaceSettingsData } from '@linedesk/actions'
import { useState } from 'react'
import { HoursGrid, TimeZoneSelect } from '../settings/BusinessHours.tsx'
import { type DayHours, hoursProblem, spansOf } from '../settings/businessHoursModel.ts'
import { Field } from '../settings/fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { browserTimeZone } from '../settings/timeZones.ts'
import { useAssistantName, useRows, useRun } from '../store.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import {
  firstHoursDraft,
  firstPickup,
  oldForwardingAfter,
  type PickupMemory,
  pickupNeedsHours,
  pickupNumberMode,
  pickupOrder,
  pickupSettings,
} from './flow.ts'

type StepProps = {
  onBack: () => void
  onNext: () => void
  memory: PickupMemory
  onMemory: (memory: PickupMemory) => void
}

const choiceText = (mode: PickupMode, name: string): { title: string; description: string } =>
  ({
    no_answer: {
      title: "When I can't answer",
      description: `Busy, or no answer after about 4 rings. Most businesses start here.`,
    },
    after_hours: {
      title: "Only when we're closed",
      description: `Outside your business hours. Calls you miss while open reach ${name} too.`,
    },
    always: {
      title: 'Every call',
      description: `${name} answers every call. Who ${name} puts callers through to, you set up later.`,
    },
  })[mode]

export function PickupStep(p: StepProps) {
  const { onBack, onNext } = p
  const settings = useWorkspaceSettings()
  const name = useAssistantName()
  if (settings.data) return <PickupForm saved={settings.data} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>When should {name} pick up?</h1>
        {settings.error ? (
          <LoadProblem what="Your settings" message={settings.error} onRetry={() => void settings.reload()} />
        ) : (
          <SkeletonRows label="Loading your settings" rows={3} />
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

function PickupForm({ saved, onBack, onNext, memory, onMemory }: StepProps & { saved: WorkspaceSettingsData }) {
  const run = useRun()
  const write = useWriteAction()
  const name = useAssistantName()
  const numbers = useRows('phone_numbers')
  const [mode, setMode] = useState<PickupMode>(() => firstPickup(saved, numbers[0]?.mode))
  const [first] = useState(() => firstHoursDraft(saved, browserTimeZone()))
  const [days, setDays] = useState<DayHours[]>(first.days)
  const [timeZone, setTimeZone] = useState(first.timeZone)
  const needsHours = pickupNeedsHours(mode)
  const problem = needsHours ? hoursProblem(days) : null

  function next() {
    if (problem) return
    const { input, hoursOnBefore } = pickupSettings(saved, mode, memory)
    const settingsInput = needsHours ? { ...input, timeZone } : input
    if (needsHours) {
      const hours = spansOf(days)
      void run('businessHours.set', { hours })
      patchWorkspaceSettings({ ...settingsInput, businessHours: hours })
    } else patchWorkspaceSettings(settingsInput)
    void run('workspace.updateSettings', settingsInput)
    // A number connected already (back from the phone step, or set up before): its forwarding follows the choice.
    // Run directly so the phone step shows the new code at once (phone_numbers is polled); if that fails, the
    // outbox takes it and reports a refusal like any other change.
    const wanted = pickupNumberMode(mode)
    let oldForwarding = memory.oldForwarding
    for (const n of numbers)
      if ((n.mode === 'forward_conditional' || n.mode === 'forward_all') && n.mode !== wanted) {
        oldForwarding = oldForwardingAfter(n.mode, wanted, oldForwarding)
        const input = { phoneNumberId: n.id, mode: wanted }
        write('phoneNumber.update', input).catch(() => void run('phoneNumber.update', input))
      }
    onMemory({ hoursOnBefore, oldForwarding })
    onNext()
  }
  useStepKeys({ onEnter: next, onEscape: onBack })

  const set = (weekday: number, change: Partial<DayHours>) =>
    setDays(all => all.map(d => (d.weekday === weekday ? { ...d, ...change } : d)))
  return (
    <>
      <div className="ob-body">
        <h1>When should {name} pick up?</h1>
        <p className="ob-lede">You keep your number. You can change this later.</p>
        <div className="k-radios ob-pickup" role="radiogroup" aria-label={`When ${name} picks up`}>
          {pickupOrder.map(m => (
            <RadioCard
              key={m}
              name="ob-pickup"
              checked={mode === m}
              onPick={() => setMode(m)}
              {...choiceText(m, name)}
            />
          ))}
        </div>
        {needsHours && (
          <>
            <Field id="ob-tz" label="Time zone">
              <TimeZoneSelect id="ob-tz" value={timeZone} onChange={setTimeZone} />
            </Field>
            <span className="ob-label">Business hours</span>
            <HoursGrid days={days} set={set} canEdit />
          </>
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
