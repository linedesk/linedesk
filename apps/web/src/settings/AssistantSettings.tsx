// Assistant settings: name, greeting, AI disclosure, the business's instructions, call rules and
// business hours, one section at a time (#assistant/<section>). Edits in every section are one local
// draft: Save runs assistant.update and businessHours.set through the outbox; a section with unsaved
// changes keeps a dot in the nav while you look at another one.
import { CALL_RULES_MAX, DEFAULT_CALL_RULES, INSTRUCTIONS_MAX } from '@linedesk/actions'
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renameInGreeting } from '../onboarding/flow.ts'
import { useAssistants, useRows, useRun } from '../store.tsx'
import { onSaveKey, SaveBar } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { type PageSection, SettingsLayout, sectionHash, useSection } from '../ui/SettingsLayout.tsx'
import {
  callRulesToSave,
  type Draft,
  draftOf,
  draftProblem,
  isDefaultCallRules,
  isDirty,
  keepDraft,
  keptDraft,
  mergeDraft,
  normalized,
  profileOf,
  spokenLength,
  staleGreetingName,
  withDisclosure,
  withoutDisclosure,
} from './assistantDraft.ts'
import { AssistantHeader } from './AssistantHeader.tsx'
import { BusinessHours, useBusinessHours } from './BusinessHours.tsx'
import { CalendarSettings } from './Calendar.tsx'
import { CONNECT_RETURN_KEY } from './calendarModel.ts'
import { Field, Section, SwitchRow, TextArea } from './fields.tsx'
import { TestCallBar, TestCallButton, useTestCall } from './TestCall.tsx'

type SectionId = 'greeting' | 'instructions' | 'rules' | 'hours' | 'calendar'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'greeting', label: 'Greeting', description: 'Name, first sentence, AI disclosure' },
  { id: 'instructions', label: 'Instructions', description: 'What the assistant knows about the business' },
  { id: 'rules', label: 'Call rules', description: 'How calls are handled' },
  { id: 'hours', label: 'Business hours', description: 'When the office is open' },
  { id: 'calendar', label: 'Calendar', description: 'Accounts, calendars and appointment types' },
]
/** Which draft fields each section holds; hours are their own draft. */
const sectionFields: Record<Exclude<SectionId, 'hours' | 'calendar'>, (keyof Draft)[]> = {
  greeting: ['name', 'greeting', 'disclose_ai'],
  instructions: ['instructions'],
  rules: ['call_rules'],
}

type SectionProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }

const count = (n: number) => n.toLocaleString('en-US')

function Greeting({ draft, set, renamedFrom }: SectionProps & { renamedFrom: string | null }) {
  const stale = renamedFrom ? staleGreetingName(draft.greeting, renamedFrom, draft.name) : null
  /** The switch and the greeting say the same thing: turning it on or off adds or removes the disclosure. */
  function disclose(on: boolean) {
    set('disclose_ai', on)
    set('greeting', on ? withDisclosure(draft.greeting, draft.name) : withoutDisclosure(draft.greeting))
  }
  return (
    <Section id="as-greeting" title="Greeting" description="The first sentence of every call.">
      <Field id="as-greet" label="Greeting" error={draft.greeting.trim() ? null : 'The greeting cannot be empty.'}>
        <TextArea
          id="as-greet"
          value={draft.greeting}
          onChange={v => set('greeting', v)}
          invalid={!draft.greeting.trim()}
        />
        <span className="help">{spokenLength(draft.greeting)}</span>
        {stale && (
          <span className="help as-stale">
            Still says "{stale}".
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set('greeting', renameInGreeting(draft.greeting, stale, draft.name.trim()))}
            >
              Use {draft.name.trim()}
            </Button>
          </span>
        )}
      </Field>
      <SwitchRow
        title="Say it's an AI assistant"
        description={draft.disclose_ai ? undefined : 'Some states require it.'}
        on={draft.disclose_ai}
        onChange={disclose}
      />
    </Section>
  )
}

function Instructions({ draft, set }: SectionProps) {
  return (
    <Section
      id="as-instructions"
      title="Instructions"
      description="Write it like you would brief a new hire."
      help="Services, service area, prices, answers to common questions, what counts as urgent. Opening hours go in Business hours."
    >
      <Field id="as-instr" label="Instructions">
        <TextArea
          id="as-instr"
          tall
          value={draft.instructions}
          onChange={v => set('instructions', v)}
          placeholder={
            'We are a family-run plumbing company in Portland.\nServices: leak repair, water heaters, drain cleaning.\nService area: Portland, Beaverton, Lake Oswego.'
          }
        />
        <span className="help">
          {count(draft.instructions.trim().length)} / {count(INSTRUCTIONS_MAX)}
        </span>
      </Field>
    </Section>
  )
}

function CallRules({ draft, set }: SectionProps) {
  const isDefault = isDefaultCallRules(draft)
  return (
    <Section
      id="as-rules"
      title="Call rules"
      description="What the assistant does on every call."
      help="The assistant always takes a message and always says it is an AI when asked, whatever the rules say."
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={isDefault}
          onClick={() => set('call_rules', DEFAULT_CALL_RULES)}
          title="Replace the rules with the default"
        >
          Reset to default
        </Button>
      }
    >
      <Field id="as-rules-text" label="Rules" aside={isDefault ? 'Default' : undefined}>
        <TextArea id="as-rules-text" tall value={draft.call_rules} onChange={v => set('call_rules', v)} />
        <span className="help">
          {count(draft.call_rules.trim().length)} / {count(CALL_RULES_MAX)}
        </span>
      </Field>
    </Section>
  )
}

type Props = { canEdit: boolean; toast: (text: string) => void }

type FormProps = Props & {
  assistant: Assistant
  assistants: Assistant[]
  numbers: PhoneNumber[]
  onPick: (id: string) => void
}

function Form({ assistant, assistants, numbers, onPick, canEdit, toast }: FormProps) {
  const run = useRun()
  const page = `assistant/${assistant.id}`
  const current = useSection(page, sections)
  const testCall = useTestCall(canEdit, assistant)
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null)
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
  const hours = useBusinessHours()
  const changed = dirty || hours.dirty
  const unsaved = useMemo(() => {
    const clean = [normalized(draft), normalized(saved)] as const
    const marked = new Set<SectionId>(
      (Object.keys(sectionFields) as Exclude<SectionId, 'hours' | 'calendar'>[]).filter(id =>
        sectionFields[id].some(key => JSON.stringify(clean[0][key]) !== JSON.stringify(clean[1][key])),
      ),
    )
    if (hours.dirty) marked.add('hours')
    return marked
  }, [draft, saved, hours.dirty])

  /** Shows the section a field is in, then puts the cursor there. */
  function goTo(section: SectionId, field: string) {
    if (section !== current) window.location.hash = sectionHash(page, section)
    setTimeout(() => document.getElementById(field)?.focus(), 0)
  }

  function save(e: FormEvent) {
    e.preventDefault()
    // The greeting shows its error under the field: go there instead of a toast that outlives the fix.
    if (!draft.greeting.trim()) return goTo('greeting', 'as-greet')
    const problem = draftProblem(draft) ?? hours.problem
    if (problem) return toast(problem)
    if (dirty) {
      const clean = normalized(draft)
      // The name is renamed in place (AssistantHeader), not with Save.
      void run('assistant.update', {
        assistantId: assistant.id,
        greeting: clean.greeting,
        disclose_ai: clean.disclose_ai,
        business_profile: profileOf(clean),
        call_rules: callRulesToSave(clean),
      })
      setDraft(clean) // the form shows what was saved, so it is not "dirty" any more
    }
    hours.save()
    toast('Assistant settings saved.')
  }
  function cancel() {
    setDraft(saved)
    hours.discard()
  }
  const elsewhere = [...unsaved].filter(id => id !== current)
  const note =
    elsewhere.length > 0
      ? `Unsaved changes in ${elsewhere.map(id => sections.find(s => s.id === id)!.label).join(', ')}${unsaved.has(current) ? ' and here' : ''}`
      : undefined

  return (
    <form onSubmit={save} onKeyDown={e => onSaveKey(e, canEdit && changed)}>
      <SettingsLayout
        page={page}
        title="Assistant"
        heading={
          <AssistantHeader
            assistant={assistant}
            assistants={assistants}
            numbers={numbers}
            canEdit={canEdit}
            onPick={onPick}
            onRenamed={setRenamedFrom}
            toast={toast}
          />
        }
        description={canEdit ? undefined : 'Only owners and admins can change these.'}
        actions={<TestCallButton session={testCall} />}
        banner={<TestCallBar session={testCall} />}
        sections={sections}
        current={current}
        unsaved={unsaved}
      >
        <fieldset className="st-fields" disabled={!canEdit}>
          {current === 'greeting' && <Greeting draft={draft} set={set} renamedFrom={renamedFrom} />}
          {current === 'instructions' && <Instructions draft={draft} set={set} />}
          {current === 'rules' && <CallRules draft={draft} set={set} />}
          {current === 'hours' && (
            <BusinessHours hours={hours} canEdit={canEdit} name={draft.name.trim() || 'the assistant'} />
          )}
        </fieldset>
        {current === 'calendar' && <CalendarSettings assistant={assistant} canEdit={canEdit} toast={toast} />}
        {canEdit && <SaveBar dirty={changed} onCancel={cancel} note={note} />}
      </SettingsLayout>
    </form>
  )
}

/**
 * The calendar connect returns to `#assistant/calendar?…` (the API does not know which assistant):
 * back to the assistant it started from, with the result for the page to show.
 */
function returnFromCalendarConnect(assistants: Assistant[]) {
  const [path, query] = window.location.hash.replace(/^#/, '').split('?')
  if (path !== 'assistant/calendar') return
  let id: string | null = null
  try {
    id = sessionStorage.getItem(CONNECT_RETURN_KEY)
    sessionStorage.removeItem(CONNECT_RETURN_KEY)
  } catch {}
  const assistant = assistants.find(a => a.id === id) ?? assistants[0]
  if (assistant) history.replaceState(null, '', `#assistant/${assistant.id}/calendar${query ? `?${query}` : ''}`)
}

/** The assistant the hash names (`#assistant/<id>/<section>`), else the workspace's first. */
function assistantInHash(assistants: Assistant[]): Assistant | undefined {
  const [, id] = window.location.hash.replace(/^#/, '').split('?')[0]!.split('/')
  return assistants.find(a => a.id === id) ?? assistants[0]
}

export function AssistantSettings(props: Props) {
  const assistants = useAssistants()
  const numbers = useRows('phone_numbers').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [, rerender] = useState(0)
  useEffect(() => {
    const onHash = () => rerender(n => n + 1)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (assistants.length) returnFromCalendarConnect(assistants)
  const assistant = assistantInHash(assistants)
  const onPick = useCallback((id: string) => {
    window.location.hash = `#assistant/${id}/greeting`
  }, [])
  return (
    <div className="page">
      {assistant ? (
        <Form
          key={assistant.id}
          assistant={assistant}
          assistants={assistants}
          numbers={numbers}
          onPick={onPick}
          {...props}
        />
      ) : (
        <div className="empty">
          <b>No assistant yet</b>
          <span>This workspace has no assistant set up.</span>
        </div>
      )}
    </div>
  )
}
