// Step 3, "When should Maya pick up?": when the business can't answer (the default), when it is closed,
// or every call. The choices speak as the business ("we"). Business hours are asked only for "when we're closed". The choice picks the forwarding
// code on the phone step; routing stays with the number's mode and the hours (no new call routing). Before the trial
// (Linedesk Cloud) it also asks how many calls Maya answers at the same time (ExtraCalls.tsx), so the pay step stays
// short.
import type { PickupMode, WorkspaceSettingsData } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { HoursGrid, TimeZoneSelect } from '../settings/BusinessHours.tsx'
import { type DayHours, hoursProblem, spansOf } from '../settings/businessHoursModel.ts'
import { Field } from '../settings/fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { browserTimeZone } from '../settings/timeZones.ts'
import { useAssistantName, useRows, useRun } from '../store.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { type CallsOffer, ExtraCallsPicker, useExtraCalls } from './ExtraCalls.tsx'
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
  /** Before the trial: the workspace and the calls at the same time it may add (none: no picker). */
  calls?: { workspaceId: string; offer: CallsOffer }
}

const choiceText: Record<PickupMode, { title: MessageKey; description: MessageKey }> = {
  no_answer: {
    title: msg('onboarding.pickup.noAnswer.title'),
    description: msg('onboarding.pickup.noAnswer.description'),
  },
  after_hours: {
    title: msg('onboarding.pickup.afterHours.title'),
    description: msg('onboarding.pickup.afterHours.description'),
  },
  always: {
    title: msg('onboarding.pickup.always.title'),
    description: msg('onboarding.pickup.always.description'),
  },
}

export function PickupStep(p: StepProps) {
  const { onBack, onNext } = p
  const t = useT()
  const settings = useWorkspaceSettings()
  const name = useAssistantName()
  if (settings.data) return <PickupForm saved={settings.data} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.pickup.title', { name })}</h1>
        <Loading
          what={t('onboarding.pickup.loading')}
          loading
          error={settings.error}
          onRetry={() => void settings.reload()}
          skeleton={<SkeletonFields fields={3} />}
        />
      </div>
      {settings.error ? (
        <Foot onBack={onBack} onContinue={onNext} canContinue label={t('onboarding.action.later')} />
      ) : (
        <Foot onBack={onBack} onContinue={onNext} canContinue={false} />
      )}
    </>
  )
}

function PickupForm({ saved, onBack, onNext, memory, onMemory, calls }: StepProps & { saved: WorkspaceSettingsData }) {
  const t = useT()
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
        <h1>{t('onboarding.pickup.title', { name })}</h1>
        <p className="ob-lede">{t('onboarding.pickup.lede')}</p>
        <div className="k-radios ob-pickup" role="radiogroup" aria-label={t('onboarding.pickup.groupLabel', { name })}>
          {pickupOrder.map(m => (
            <RadioCard
              key={m}
              name="ob-pickup"
              checked={mode === m}
              onPick={() => setMode(m)}
              title={t(choiceText[m].title)}
              description={t(choiceText[m].description, { name })}
            />
          ))}
        </div>
        {needsHours && (
          <>
            <Field id="ob-tz" label={t('onboarding.pickup.timeZone')}>
              <TimeZoneSelect id="ob-tz" value={timeZone} onChange={setTimeZone} />
            </Field>
            <span className="ob-label">{t('onboarding.pickup.businessHours')}</span>
            <HoursGrid days={days} set={set} canEdit />
          </>
        )}
        {calls && calls.offer.maxExtra > 0 && <CallsChoice {...calls} />}
        {problem && <Note tone="danger">{problem}</Note>}
      </div>
      <Foot onBack={onBack} onContinue={next} canContinue={!problem} />
    </>
  )
}

/** Calls at the same time before the trial: kept in this browser until the pay step sells them with the plan. */
function CallsChoice({ workspaceId, offer }: { workspaceId: string; offer: CallsOffer }) {
  const [extra, setExtra] = useExtraCalls(workspaceId, offer)
  return <ExtraCallsPicker calls={offer} extra={extra} onChange={setExtra} />
}
