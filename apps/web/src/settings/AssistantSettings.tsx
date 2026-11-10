// Assistant settings, reduced to what the data model has. Edits are a local draft; Save runs
// assistant.update through the outbox.
import type { Assistant } from '@callfront/db/types'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAssistant, useRun } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { type Draft, draftOf, draftProblem, isDirty, keepDraft, keptDraft, mergeDraft, normalized, profileOf, spokenLength, withDisclosure, withoutDisclosure } from './assistantDraft.ts'
import { Field, RemoveButton, replaceAt, Section, SwitchRow, TextArea, TextInput, without } from './fields.tsx'

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
      <Field id="as-greet" label="Greeting" >
        <TextArea id="as-greet" value={draft.greeting} onChange={v => set('greeting', v)} />
        <span className="help">{draft.greeting.trim().length} characters · {spokenLength(draft.greeting)}</span>
      </Field>
      <SwitchRow title="Tell callers it's an AI assistant" on={draft.disclose_ai} onChange={disclose}
        description={draft.disclose_ai ? `${name} says it is an AI assistant in the greeting.` : 'Some states require disclosure. We recommend leaving this on.'} />
    </Section>
  )
}

function Services({ draft, set }: SectionProps) {
  const list = draft.services
  return (
    <Field label="Services">
      <div className="st-list">
        {list.map((service, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, so a key from the text would remount the field on every keystroke
          <div key={i} className="st-li st-svc st-svc-one">
            <TextInput value={service} label="Service" placeholder="Service" onChange={v => set('services', replaceAt(list, i, v))} />
            <RemoveButton label={`Remove ${service || 'service'}`} onClick={() => set('services', without(list, i))} />
          </div>
        ))}
      </div>
      <div><Button size="sm" variant="ghost" icon="plus" onClick={() => set('services', [...list, ''])}>Add service</Button></div>
    </Field>
  )
}

function Faqs({ draft, set }: SectionProps) {
  const list = draft.faqs
  return (
    <Field label="Questions callers ask" help="Answers are used word for word.">
      <div className="st-list">
        {list.map((faq, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, so a key from the text would remount the field on every keystroke
          <div key={i} className="st-li st-faq">
            <div className="st-faq-in">
              <TextInput value={faq.q} label="Question" placeholder="Question" onChange={q => set('faqs', replaceAt(list, i, { ...faq, q }))} />
              <TextArea small value={faq.a} label="Answer" placeholder="Answer" onChange={a => set('faqs', replaceAt(list, i, { ...faq, a }))} />
            </div>
            <RemoveButton label="Remove question" onClick={() => set('faqs', without(list, i))} />
          </div>
        ))}
      </div>
      <div><Button size="sm" variant="ghost" icon="plus" onClick={() => set('faqs', [...list, { q: '', a: '' }])}>Add question</Button></div>
    </Field>
  )
}

function Knowledge(props: SectionProps) {
  const { draft, set } = props
  return (
    <Section id="as-knowledge" title="Business knowledge" description="Write it like you would tell a new hire.">
      <Field id="as-desc" label="About the business"><TextArea id="as-desc" small value={draft.description} onChange={v => set('description', v)} /></Field>
      <Services {...props} />
      <Field id="as-area" label="Service area"><TextInput id="as-area" value={draft.service_area} onChange={v => set('service_area', v)} /></Field>
      <Faqs {...props} />
    </Section>
  )
}

function Hours({ draft, set }: SectionProps) {
  return (
    <Section id="as-hours" title="Business hours" description="When the business is open, in your own words.">
      <Field id="as-hours-in" label="Hours"><TextInput id="as-hours-in" value={draft.hours} placeholder="e.g. Mon–Fri 7 am – 6 pm, emergencies 24/7" onChange={v => set('hours', v)} /></Field>
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
      business_profile: profileOf(clean, assistant.business_profile),
    })
    setDraft(clean) // the form shows what was saved, so it is not "dirty" any more
    toast('Assistant settings saved.')
  }

  return (
    <form className="page-in st-page" onSubmit={save}>
      <div className="page-head"><div><h1>Assistant</h1><p>How {draft.name || 'your assistant'} answers your phone.</p></div></div>
      <fieldset className="st-fields" disabled={!canEdit}>
        <Greeting draft={draft} set={set} />
        <Knowledge draft={draft} set={set} />
        <Hours draft={draft} set={set} />
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
