// Step 1: the assistant's name and what callers should know (prefills the assistant's instructions).
import { useState } from 'react'
import { Field, TextArea, TextInput } from '../settings/fields.tsx'
import { useAssistant, useRun } from '../store.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import { renameInGreeting } from './flow.ts'

const PLACEHOLDER = 'We fix leaks, drains and water heaters in Portland. Open Mon–Fri 7 AM–6 PM. Emergencies around the clock. Estimates are free.'

export function BusinessStep({ businessName, onNext }: { businessName: string; onNext: () => void }) {
  const assistant = useAssistant()
  const run = useRun()
  // The assistant row arrives through sync; until then the fields wait for it.
  const [draft, setDraft] = useState<{ name: string; instructions: string } | null>(null)
  const shown = draft ?? (assistant ? { name: assistant.name, instructions: assistant.business_profile.instructions ?? '' } : null)
  const name = shown?.name.trim() ?? ''
  const canContinue = !!assistant && name.length > 0

  function next() {
    if (!assistant || !shown || !canContinue) return
    const instructions = shown.instructions.trim()
    if (name !== assistant.name || instructions !== (assistant.business_profile.instructions ?? '')) {
      void run('assistant.update', {
        assistantId: assistant.id,
        name,
        greeting: renameInGreeting(assistant.greeting, assistant.name, name),
        business_profile: { ...assistant.business_profile, instructions },
      })
    }
    onNext()
  }
  useStepKeys({ onEnter: next })

  const set = (patch: Partial<{ name: string; instructions: string }>) => shown && setDraft({ ...shown, ...patch })
  return (
    <>
      <div className="ob-body">
        <h1>Who answers for {businessName}?</h1>
        <p className="ob-lede">Name your assistant and tell it what callers usually need to know. You can change both later in Assistant settings.</p>
        <Field id="ob-name" label="Assistant's name">
          <TextInput id="ob-name" value={shown?.name ?? ''} onChange={v => set({ name: v })} placeholder="Maya" />
        </Field>
        <Field id="ob-know" label="What should callers know?">
          <TextArea id="ob-know" value={shown?.instructions ?? ''} onChange={v => set({ instructions: v })} placeholder={PLACEHOLDER} />
        </Field>
        <p className="ob2-note">Services, area, hours, prices, anything you say on the phone a lot. Plain sentences are fine.</p>
      </div>
      <Foot onContinue={next} canContinue={canContinue} hint={assistant ? undefined : 'Loading your assistant…'} />
    </>
  )
}
