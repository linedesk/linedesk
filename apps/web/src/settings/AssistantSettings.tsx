// Assistant settings: name, greeting, AI disclosure and the business's free-text instructions.
// Edits are a local draft; Save runs assistant.update through the outbox.
import { INSTRUCTIONS_MAX } from '@callfront/actions'
import type { Assistant } from '@callfront/db/types'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAssistant, useRun } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { type Draft, draftOf, draftProblem, isDirty, keepDraft, keptDraft, mergeDraft, normalized, profileOf, spokenLength, withDisclosure, withoutDisclosure } from './assistantDraft.ts'
import { Field, Section, SwitchRow, TextArea, TextInput } from './fields.tsx'

type SectionProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }

function Greeting({ draft, set }: SectionProps) {
  const name = draft.name.trim() || 'The assistant'
  /** The switch and the greeting say the same thing: turning it on or off adds or removes the disclosure. */
  function disclose(on: boolean) {
    set('disclose_ai', on)
    set('greeting', on ? withDisclosure(draft.greeting, draft.name) : withoutDisclosure(draft.greeting))
  }
  return (
    <Section id="as-greeting" title="Greeting" description="The first sentence of every call.">
      <div className="row2"><Field id="as-name" label="Assistant name"><TextInput id="as-name" value={draft.name} onChange={v => set('name', v)} /></Field></div>
      <Field id="as-greet" label="Greeting">
        <TextArea id="as-greet" value={draft.greeting} onChange={v => set('greeting', v)} />
        <span className="help">{draft.greeting.trim().length} characters · {spokenLength(draft.greeting)}</span>
      </Field>
      <SwitchRow title="Tell callers it's an AI assistant" on={draft.disclose_ai} onChange={disclose}
        description={draft.disclose_ai ? `${name} says it is an AI assistant in the greeting.` : 'Some states require disclosure. We recommend leaving this on.'} />
    </Section>
  )
}

function Instructions({ draft, set }: SectionProps) {
  const name = draft.name.trim() || 'the assistant'
  return (
    <Section id="as-instructions" title="Instructions" description={`What ${name} should know about the business and how to handle calls. Write it like you would tell a new hire.`}>
      <Field id="as-instr" label="Instructions" help="Services, service area, hours, prices you quote, answers to common questions, what counts as urgent.">
        <TextArea id="as-instr" tall value={draft.instructions} onChange={v => set('instructions', v)}
          placeholder={'We are a family-run plumbing company in Portland.\nServices: leak repair, water heaters, drain cleaning.\nHours: Mon–Fri 7 am – 6 pm, emergencies 24/7.'} />
        <span className="help">{draft.instructions.trim().length.toLocaleString('en-US')} of {INSTRUCTIONS_MAX.toLocaleString('en-US')} characters</span>
      </Field>
    </Section>
  )
}

type Props = { canEdit: boolean; toast: (text: string) => void }

function Form({ assistant, canEdit, toast }: Props & { assistant: Assistant }) {
  const run = useRun()
  const savedJson = JSON.stringify(draftOf(assistant))
  const saved = useMemo(() => JSON.parse(savedJson) as Draft, [savedJson])
  const [draft, setDraft] = useState(() => keptDraft(assistant.id) ?? saved) // an edit left unsaved earlier comes back
  const mergedFrom = useRef(saved)
  const dirty = isDirty(draft, saved)
  useEffect(() => keepDraft(assistant.id, dirty ? draft : null), [assistant.id, draft, dirty])
  useEffect(() => {
    // A change from elsewhere: untouched fields follow it, the user's unsaved edits stay.
    const previous = mergedFrom.current
    mergedFrom.current = saved
    if (previous !== saved) setDraft(d => mergeDraft(d, previous, saved))
  }, [saved])
  const set: SectionProps['set'] = (key, value) => setDraft(d => ({ ...d, [key]: value }))

  function save(e: FormEvent) {
    e.preventDefault()
    const problem = draftProblem(draft)
    if (problem) return toast(problem)
    const clean = normalized(draft)
    void run('assistant.update', {
      assistantId: assistant.id, name: clean.name, greeting: clean.greeting, disclose_ai: clean.disclose_ai,
      business_profile: profileOf(clean),
    })
    setDraft(clean) // the form shows what was saved, so it is not "dirty" any more
    toast('Assistant settings saved.')
  }

  return (
    <form className="page-in st-page" onSubmit={save}>
      <div className="page-head"><div><h1>Assistant</h1><p>How {draft.name || 'your assistant'} answers your phone.</p></div></div>
      {/* The test-call card (telephony session, settings/TestCall.tsx) goes here, above the settings. */}
      <fieldset className="st-fields" disabled={!canEdit}>
        <Greeting draft={draft} set={set} />
        <Instructions draft={draft} set={set} />
      </fieldset>
      <div className="save-bar st-save">
        <span className="help">{!canEdit ? 'Only owners and admins can change these settings.' : dirty ? 'Unsaved changes. They stay here until you save or discard them.' : 'Changes apply to the next call.'}</span>
        {canEdit && dirty && <Button variant="ghost" onClick={() => setDraft(saved)}>Discard</Button>}
        <Button type="submit" variant="primary" disabled={!canEdit || !dirty}>Save</Button>
      </div>
    </form>
  )
}

export function AssistantSettings(props: Props) {
  const assistant = useAssistant()
  return <div className="page">{assistant ? <Form assistant={assistant} {...props} /> : <div className="empty"><b>No assistant yet</b><span>This workspace has no assistant set up.</span></div>}</div>
}
