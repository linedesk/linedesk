// Step 1: what callers should know about the business (prefills the assistant's instructions).
import { useState } from 'react'
import { Field, TextArea } from '../settings/fields.tsx'
import { useAssistant, useRun } from '../store.tsx'
import { Foot, useStepKeys } from './Frame.tsx'

const PLACEHOLDER =
  'We fix leaks, drains and water heaters in Portland. Open Mon–Fri 7 AM–6 PM. Emergencies around the clock. Estimates are free.'

export function BusinessStep({ businessName, onNext }: { businessName: string; onNext: () => void }) {
  const assistant = useAssistant()
  const run = useRun()
  // The assistant row arrives through sync; until then the field waits for it.
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? assistant?.business_profile.instructions ?? ''

  function next() {
    if (!assistant) return
    const instructions = shown.trim()
    if (instructions !== (assistant.business_profile.instructions ?? '')) {
      void run('assistant.update', {
        assistantId: assistant.id,
        business_profile: { ...assistant.business_profile, instructions },
      })
    }
    onNext()
  }
  useStepKeys({ onEnter: next })

  return (
    <>
      <div className="ob-body">
        <h1>What should callers know about {businessName}?</h1>
        <p className="ob-lede">Your assistant answers with this. You can change it any time.</p>
        <Field id="ob-know" label="What you do" help="Services, area, hours, prices.">
          <TextArea id="ob-know" value={shown} onChange={setDraft} placeholder={PLACEHOLDER} />
        </Field>
      </div>
      <Foot onContinue={next} canContinue={!!assistant} hint={assistant ? undefined : 'Loading your assistant…'} />
    </>
  )
}
