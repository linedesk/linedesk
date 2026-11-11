// Assistant settings by topic, one section at a time (#assistant/<id>/<section>): general (greeting), business
// info, hours and holidays, rules (AI disclosure, tone, behaviour checklist), transfers (transfer
// contacts), booking, voice, and Advanced (languages, raw call rules, silence, keypad menu).
// The assistant's own fields are one local draft: Save runs assistant.update through the outbox; a section
// with unsaved changes keeps a dot in the nav. Hours, holidays and booking save on their own.
import { AI_DISCLOSURE_LABELS, AI_DISCLOSURE_MODES, type AiDisclosure, BEHAVIOURS, CALL_RULES_MAX, COMMUNICATION_STYLE_LABELS, COMMUNICATION_STYLES, disclosesAtStart, greetingWithDisclosure, withDisclosure, withoutDisclosure, DEFAULT_CALL_RULES, DEFAULT_KNOWN_CALLER_GREETING, knownCallerGreetingProblem, SILENCE_CLOSING_MAX, KEYPAD_MENU_LABEL_MAX, KEYPAD_MENU_MAX_OPTIONS, type AssistantLanguages, type Language, languageCodes, LANGUAGES, GREETING_VARIABLES, greetingVariablePattern, usesGreetingVariable } from '@linedesk/actions'
import type { Assistant, KeypadMenuAction, KeypadMenuOption, PhoneNumber } from '@linedesk/db/types'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renameInGreeting } from '../onboarding/flow.ts'
import { useAssistants, useRows, useRun } from '../store.tsx'
import { onSaveKey, SaveBar } from '../ui/form.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
import { LoadProblem, Skeleton, useLoadState } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, sectionHash, useSection } from '../ui/SettingsLayout.tsx'
import {
  behavioursToSave,
  callRulesToSave,
  outsideToSave,
  type Draft,
  draftOf,
  draftProblem,
  isDefaultCallRules,
  isDirty,
  keepDraft,
  keypadProblem,
  keypadToSave,
  languagesProblem,
  languagesToSave,
  mainOf,
  pickedOthers,
  withMainLanguage,
  nextFreeKey,
  keptDraft,
  mergeDraft,
  normalized,
  profileOf,
  silenceProblem,
  silenceSummary,
  silenceToSave,
  spokenLength,
  staleGreetingName,
  transferProblem,
  transfersToSave,
} from './assistantDraft.ts'
import { AssistantHeader } from './AssistantHeader.tsx'
import { CalendarSettings } from './Calendar.tsx'
import { CONNECT_RETURN_KEY } from './calendarModel.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { Field, Section, SelectRow, SwitchRow, TextArea, TextInput } from './fields.tsx'
import { useWorkspaceSettings } from './settings-api.ts'
import { Knowledge } from './Knowledge.tsx'
import { VariableInput } from './VariableInput.tsx'
import { VoiceSettings } from './VoiceSettings.tsx'
import { TestCallButton, useTestCall } from './TestCall.tsx'
import { TestCallPanel } from './TestCallPanel.tsx'
import { TransferContacts, transferFieldId } from './TransferContacts.tsx'
import { BusinessHours } from './BusinessHours.tsx'
import { Holidays, VacationMode } from './Holidays.tsx'

type SectionId = 'general' | 'business' | 'hours' | 'rules' | 'transfers' | 'booking' | 'voice' | 'advanced'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'general', label: 'General', description: 'Greeting and returning callers' },
  { id: 'business', label: 'Business info', description: 'What you do, services, prices, FAQs and documents' },
  { id: 'hours', label: 'Hours & holidays', description: 'Weekly hours, holidays, vacation mode' },
  { id: 'rules', label: 'Rules', description: 'AI disclosure, tone and how calls are handled' },
  { id: 'transfers', label: 'Transfers', description: 'Who calls are put through to' },
  { id: 'booking', label: 'Booking & Calendar', description: 'Calendars and appointment types' },
  { id: 'voice', label: 'Voice', description: 'How the assistant sounds' },
  { id: 'advanced', label: 'Advanced', description: 'Languages, call rules, silence, keypad menu' },
]
/** Sections that save on their own, outside the assistant's draft. */
type OwnSection = 'hours' | 'booking'
/** Which draft fields each section holds. */
const sectionFields: Record<Exclude<SectionId, OwnSection>, (keyof Draft)[]> = {
  business: ['instructions', 'services', 'faqs', 'website'],
  general: ['name', 'greeting', 'greeting_known_caller', 'greeting_outside'],
  rules: ['ai_disclosure', 'communication_style', 'behaviours'],
  transfers: ['transfers'],
  voice: ['voice'],
  advanced: ['call_rules', 'silence_first_gap_s', 'silence_reminders', 'silence_closing', 'keypad_on', 'keypad_options', 'languages'],
}
/** Section ids from before the regrouping, so old links and bookmarks still land in the right place. */
const OLD_SECTIONS: Record<string, SectionId> = {
  greeting: 'general',
  knowledge: 'business',
  transfer: 'transfers',
  calls: 'transfers',
  calendar: 'booking',
  emergencies: 'transfers',
}

/** The assistant's name as the help texts say it, also while the name field is being edited. */
const assistantName = (draft: Draft) => draft.name.trim() || 'The assistant'

type SectionProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }
const count = (n: number) => n.toLocaleString('en-US')

/** An example contact for the returning-caller preview. */
const EXAMPLE_CALLER = { first_name: 'Sarah', last_name: 'Miller' } as const
/** The returning-caller text with the example contact filled in, as a caller would hear it. */
const withExampleCaller = (text: string) =>
  GREETING_VARIABLES.reduce((t, v) => t.replace(greetingVariablePattern(v.key), EXAMPLE_CALLER[v.key]), text)

function Greeting({
  draft,
  set,
  renamedFrom,
  hoursOn,
  canEdit,
}: SectionProps & { renamedFrom: string | null; hoursOn: boolean; canEdit: boolean }) {
  const stale = renamedFrom ? staleGreetingName(draft.greeting, renamedFrom, draft.name) : null
  const knownProblem = knownCallerGreetingProblem(draft.greeting_known_caller)
  const name = assistantName(draft)
  const known = draft.greeting_known_caller.trim()
  return (
    <Section id="as-greeting" title="Greeting" description={`The first thing callers hear when ${name} picks up.`}>
      <Field
        id="as-greet"
        label="Every caller hears"
        aside={draft.greeting.trim() ? spokenLength(draft.greeting) : undefined}
        error={draft.greeting.trim() ? null : 'The greeting cannot be empty.'}
      >
        <TextArea
          id="as-greet"
          value={draft.greeting}
          onChange={v => set('greeting', v)}
          invalid={!draft.greeting.trim()}
          placeholder={`Thanks for calling. This is ${name}. How can I help?`}
        />
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
      <Field id="as-greet-known" label="Saved contacts hear first" aside="Optional" error={knownProblem}>
        <VariableInput
          id="as-greet-known"
          label="Said first when a saved contact calls"
          value={draft.greeting_known_caller}
          onChange={v => set('greeting_known_caller', v)}
          variables={GREETING_VARIABLES}
          placeholder={DEFAULT_KNOWN_CALLER_GREETING}
          invalid={!!knownProblem}
          describedBy="as-greet-known-help"
        />
        <span className="help" id="as-greet-known-help">
          {known && !knownProblem
            ? `A saved contact hears: "${withExampleCaller(known)} ${draft.greeting.trim()}"`
            : 'When someone in your contacts calls again, this is said before the greeting. Empty: they hear the usual greeting.'}
          {known && usesGreetingVariable(known, 'last_name') && ' Anyone calling from that number hears the full name.'}
        </span>
      </Field>
      {hoursOn && (
        <Field
          id="as-greet-out"
          label="When you're closed, callers hear instead"
          aside="Optional"
          labelAfter={<EditBusinessHours canEdit={canEdit} />}
        >
          <TextArea
            id="as-greet-out"
            value={draft.greeting_outside}
            onChange={v => set('greeting_outside', v)}
            placeholder={draft.greeting}
          />
          <span className="help">
            {draft.greeting_outside.trim() ? spokenLength(draft.greeting_outside) : 'Empty: the same greeting as during business hours.'}
          </span>
        </Field>
      )}
    </Section>
  )
}

/** The behaviour checklist: plain-language switches that add a line to the assistant's instructions. */
function Behaviours({ draft, set }: SectionProps) {
  return (
    <Section
      id="as-behaviour"
      title="How calls are handled"
      description="Switch on what fits your business."
      help={`Each switch adds a sentence to ${assistantName(draft)}'s instructions. They come before the call rules under Advanced where the two differ.`}
    >
      <div className="as-checklist">
        <AiDisclosureRow draft={draft} set={set} />
        <SelectRow
          id="as-style"
          title="Communication style"
          description="The tone your assistant uses"
          value={draft.communication_style}
          options={styleOptions}
          onChange={style => set('communication_style', style)}
        />
        {BEHAVIOURS.map(b => (
          <SwitchRow
            key={b.id}
            title={b.label}
            aside={draft.behaviours[b.id] === b.on ? undefined : 'Changed'}
            on={draft.behaviours[b.id]}
            onChange={on => set('behaviours', { ...draft.behaviours, [b.id]: on })}
          />
        ))}
      </div>
    </Section>
  )
}

const disclosureOptions = AI_DISCLOSURE_MODES.map(mode => ({ value: mode, label: AI_DISCLOSURE_LABELS[mode] }))
const styleOptions = COMMUNICATION_STYLES.map(style => ({ value: style, label: COMMUNICATION_STYLE_LABELS[style] }))

/**
 * AI disclosure, the first row of the checklist. Picking a mode that says it at the start adds the note to
 * the greeting (so the field shows what callers hear); the others take it out.
 */
function AiDisclosureRow({ draft, set }: SectionProps) {
  function pick(mode: AiDisclosure) {
    set('ai_disclosure', mode)
    set('greeting', disclosesAtStart(mode) ? withDisclosure(draft.greeting, draft.name, mainOf(draft)) : withoutDisclosure(draft.greeting, draft.name, mainOf(draft)))
  }
  const heard = disclosesAtStart(draft.ai_disclosure) && draft.greeting.trim()
    ? greetingWithDisclosure(draft.greeting, draft.name, draft.ai_disclosure, mainOf(draft))
    : null
  return (
    <SelectRow
      id="as-ai-disclosure"
      title="AI disclosure"
      description="Whether and when your assistant mentions it's an AI"
      note={heard && `Callers hear: "${heard}"`}
      value={draft.ai_disclosure}
      options={disclosureOptions}
      onChange={pick}
    />
  )
}

function CallRules({ draft, set }: SectionProps) {
  const isDefault = isDefaultCallRules(draft)
  return (
    <Section
      id="as-rules"
      title="Call rules"
      description="The instructions behind the checklist, as text."
      help={`How ${assistantName(draft)} handles a call: what to ask, what to do with emergencies, prices and sales calls. The checklist under Rules comes on top. Whatever the rules say, ${assistantName(draft)} always says it is an AI when asked and offers to take a message when it can't help.`}
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

const keyOptions = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => ({ value: k, label: k }))
const actionOptions: { value: KeypadMenuAction; label: string; description: string }[] = [
  { value: 'transfer', label: 'Urgent', description: 'Put through to a transfer contact that fits urgent calls, else marked urgent with a message' },
  { value: 'topic', label: 'Topic', description: 'The assistant knows what the call is about and goes on' },
]

/** What the caller hears, as the voice agent says it. */
const menuPreview = (options: KeypadMenuOption[]) =>
  `${[...options].sort((a, b) => a.key.localeCompare(b.key)).map(o => `For ${o.label.trim() || '…'}, press ${o.key}.`).join(' ')} Or just tell me how I can help.`

function KeypadMenu({ draft, set }: SectionProps) {
  const problem = keypadProblem(draft)
  const options = draft.keypad_options
  const update = (i: number, change: Partial<KeypadMenuOption>) =>
    set('keypad_options', options.map((o, j) => (j === i ? { ...o, ...change } : o)))
  const free = nextFreeKey(options)
  return (
    <Section
      id="as-keypad"
      title="Keypad menu"
      help={`Off by default. When on, ${assistantName(draft)} reads a short menu right after the greeting and callers can press a key or just start talking. An urgent key is handled like an emergency: put through to your on-call number when transfer is on, otherwise marked urgent with a message.`}
    >
      <SwitchRow title="Play a keypad menu" on={draft.keypad_on} onChange={on => set('keypad_on', on)} />
      {draft.keypad_on && (
        <>
          {options.map((option, i) => (
            <div className="as-keypad-row" key={option.key}>
              <Select
                id={`as-keypad-key-${i}`}
                value={option.key}
                label="Key"
                size="sm"
                options={keyOptions.filter(k => k.value === option.key || !options.some(o => o.key === k.value))}
                onChange={key => update(i, { key })}
              />
              <TextInput
                id={`as-keypad-label-${i}`}
                label="What the caller hears after For"
                value={option.label}
                onChange={label => update(i, { label: label.slice(0, KEYPAD_MENU_LABEL_MAX) })}
                placeholder="emergencies"
                invalid={!option.label.trim()}
              />
              <Select
                id={`as-keypad-action-${i}`}
                value={option.action}
                label="What the key does"
                size="sm"
                align="end"
                options={actionOptions}
                onChange={action => update(i, { action })}
              />
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                title="Remove this key"
                aria-label="Remove this key"
                onClick={() => set('keypad_options', options.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          {free && options.length < KEYPAD_MENU_MAX_OPTIONS && (
            <div>
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() => set('keypad_options', [...options, { key: free, label: '', action: 'topic' }])}
              >
                Add key
              </Button>
            </div>
          )}
          {problem ? <span className="help as-stale">{problem}</span> : <span className="help">"{menuPreview(options)}"</span>}
        </>
      )}
    </Section>
  )
}

const languageOptions = languageCodes.map(code => ({ value: code, label: LANGUAGES[code] }))
const alsoModes = (main: string): { value: AssistantLanguages['mode']; label: string; description: string }[] => [
  { value: 'english', label: 'None', description: `Other languages: answered in ${main}, with an offer to take a message` },
  { value: 'allowed', label: 'These languages', description: 'Switches only to the ones you pick' },
  { value: 'any', label: 'Any supported language', description: 'Every language listed below' },
]

function Languages({ draft, set, replace }: SectionProps & { replace: (draft: Draft) => void }) {
  const { mode } = draft.languages
  const main = mainOf(draft)
  const others = pickedOthers(draft)
  const problem = languagesProblem(draft)
  const toggle = (code: Language, on: boolean) =>
    set('languages', { ...draft.languages, allowed: languageCodes.filter(c => c !== main && (c === code ? on : others.includes(c))) })
  return (
    <Section
      id="as-languages"
      title="Languages"
      help={`${assistantName(draft)} greets and speaks in the main language; the greeting, goodbye and other fixed lines are said in it (a greeting that is still the default changes with it). When a caller speaks another language you allow, it answers in that language from then on; otherwise it goes on in the main language. Summaries and messages for the team are in English, transcripts stay in the language spoken. Same price per minute; the first reply after a switch can take a moment longer.`}
    >
      <div className="as-languages-row">
        <Field id="as-languages-main" label="Main language">
          <Select id="as-languages-main" label="Main language" value={main} options={languageOptions} onChange={code => replace(withMainLanguage(draft, code))} />
        </Field>
        <Field id="as-languages-mode" label="Also speak">
          <Select id="as-languages-mode" label="Also speak" value={mode} options={alsoModes(LANGUAGES[main])} onChange={m => set('languages', { ...draft.languages, mode: m })} />
        </Field>
      </div>
      {mode !== 'english' && (
        <div className="as-languages" role="group" aria-label={`Languages besides ${LANGUAGES[main]}`}>
          {languageCodes.filter(code => code !== main).map(code => (
            <Checkbox key={code} checked={mode === 'any' || others.includes(code)} disabled={mode === 'any'} onChange={on => toggle(code, on)}>
              {LANGUAGES[code]}
            </Checkbox>
          ))}
        </div>
      )}
      {problem && <span className="help as-stale">{problem}</span>}
    </Section>
  )
}

function Advanced({ draft, set }: SectionProps) {
  const problem = silenceProblem(draft)
  return (
    <Section
      id="as-advanced"
      title="Silence on the line"
      help={`When nobody speaks, ${assistantName(draft)} asks whether the caller is still there, waits twice as long each time, and before it hangs up always says the closing line.`}
    >
      <Field id="as-silence-gap" label="First wait, in seconds" error={problem?.startsWith('The first wait') ? problem : null}>
        <TextInput id="as-silence-gap" value={draft.silence_first_gap_s} onChange={v => set('silence_first_gap_s', v)} />
      </Field>
      <Field id="as-silence-times" label='Times to ask "Are you still there?"' error={problem?.startsWith('Ask') ? problem : null}>
        <TextInput id="as-silence-times" value={draft.silence_reminders} onChange={v => set('silence_reminders', v)} />
      </Field>
      <Field id="as-silence-closing" label="Closing line" error={problem?.startsWith('The closing') ? problem : null}>
        <TextArea id="as-silence-closing" value={draft.silence_closing} onChange={v => set('silence_closing', v)} />
        <span className="help">{problem ? `${count(draft.silence_closing.trim().length)} / ${count(SILENCE_CLOSING_MAX)}` : silenceSummary(draft)}</span>
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
  /** A save was refused over a transfer contact: its errors show from then on. */
  const [transferSaveTried, setTransferSaveTried] = useState(false)
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
  const hoursOn = useBusinessHoursOn()
  const changed = dirty
  const unsaved = useMemo(() => {
    const clean = [normalized(draft), normalized(saved)] as const
    const marked = new Set<SectionId>(
      (Object.keys(sectionFields) as Exclude<SectionId, OwnSection>[]).filter(id =>
        sectionFields[id].some(key => JSON.stringify(clean[0][key]) !== JSON.stringify(clean[1][key])),
      ),
    )
    return marked
  }, [draft, saved])

  /** Shows the section a field is in, then puts the cursor there. */
  function goTo(section: SectionId, field: string) {
    if (section !== current) window.location.hash = sectionHash(page, section)
    setTimeout(() => document.getElementById(field)?.focus(), 0)
  }

  function save(e: FormEvent) {
    e.preventDefault()
    // The greeting shows its error under the field: go there instead of a toast that outlives the fix.
    if (!draft.greeting.trim()) return goTo('general', 'as-greet')
    if (knownCallerGreetingProblem(draft.greeting_known_caller)) return goTo('general', 'as-greet-known')
    const transfer = transferProblem(draft)
    if (transfer) {
      setTransferSaveTried(true)
      return goTo('transfers', transferFieldId(transfer.index, transfer.field))
    }
    if (silenceProblem(draft)) return goTo('advanced', 'as-silence-gap')
    if (keypadProblem(draft)) return goTo('advanced', 'as-keypad-label-0')
    if (languagesProblem(draft)) return goTo('advanced', 'as-languages-mode')
    const problem = draftProblem(draft)
    if (problem) return toast(problem)
    if (dirty) {
      const clean = normalized(draft)
      // The name is renamed in place (AssistantHeader), not with Save.
      void run('assistant.update', {
        assistantId: assistant.id,
        greeting: clean.greeting,
        ai_disclosure: clean.ai_disclosure,
        communication_style: clean.communication_style,
        // For a web app of the release before, which still shows the switch.
        disclose_ai: disclosesAtStart(clean.ai_disclosure),
        greeting_known_caller: clean.greeting_known_caller,
        business_profile: profileOf(clean),
        call_rules: callRulesToSave(clean),
        ...outsideToSave(clean),
        // Only when changed: putting calls through to a number waits for a confirmed email, other edits do not.
        ...(JSON.stringify(clean.transfers) !== JSON.stringify(normalized(saved).transfers) ? { transfers: transfersToSave(clean) } : {}),
        ...silenceToSave(clean),
        ...keypadToSave(clean),
        behaviours: behavioursToSave(clean),
        ...languagesToSave(clean),
        voice: clean.voice,
      })
      setDraft(clean) // the form shows what was saved, so it is not "dirty" any more
    }
    toast('Assistant settings saved.')
  }
  function cancel() {
    setDraft(saved)
  }
  const elsewhere = [...unsaved].filter(id => id !== current)
  const note =
    elsewhere.length > 0
      ? `Unsaved changes in ${elsewhere.map(id => sections.find(s => s.id === id)!.label).join(', ')}${unsaved.has(current) ? ' and here' : ''}`
      : undefined

  // Hours and holidays have forms of their own; everything else is inside the draft's form.
  const body = (
    <>
      <fieldset className="st-fields" disabled={!canEdit}>
        {current === 'business' && (
          <Knowledge
            assistant={assistant}
            draft={draft}
            set={set}
            replace={setDraft}
            canEdit={canEdit}
            toast={toast}
          />
        )}
        {current === 'general' && (
          <Greeting draft={draft} set={set} renamedFrom={renamedFrom} hoursOn={hoursOn} canEdit={canEdit} />
        )}
        {current === 'rules' && <Behaviours draft={draft} set={set} />}
        {current === 'transfers' && (
          <>
            <TransferContacts
              transfers={draft.transfers}
              onChange={list => set('transfers', list)}
              hoursOn={hoursOn}
              assistantName={assistantName(draft)}
              showErrors={transferSaveTried}
            />
          </>
        )}
        {current === 'voice' && (
          <VoiceSettings
            assistantId={assistant.id}
            voice={draft.voice}
            onPick={v => set('voice', v)}
            canEdit={canEdit}
            toast={toast}
          />
        )}
        {current === 'advanced' && (
          <>
            <Languages draft={draft} set={set} replace={setDraft} />
            <CallRules draft={draft} set={set} />
            <Advanced draft={draft} set={set} />
            <KeypadMenu draft={draft} set={set} />
          </>
        )}
      </fieldset>
      {current === 'booking' && <CalendarSettings assistant={assistant} canEdit={canEdit} toast={toast} />}
      {canEdit && <SaveBar dirty={changed} onCancel={cancel} note={note} />}
    </>
  )

  return (
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
      banner={<TestCallPanel session={testCall} />}
      sections={sections}
      current={current}
      unsaved={unsaved}
    >
      {current === 'hours' ? (
        <>
          <BusinessHours canEdit={canEdit} />
          <Holidays canEdit={canEdit} toast={toast} />
          <VacationMode canEdit={canEdit} toast={toast} />
        </>
      ) : (
        <form onSubmit={save} onKeyDown={e => onSaveKey(e, canEdit && changed)}>
          {body}
        </form>
      )}
    </SettingsLayout>
  )
}

/**
 * The calendar connect returns to `#assistant/calendar?…` (the API does not know which assistant):
 * back to the assistant it started from, with the result for the page to show.
 */
function returnFromCalendarConnect(assistants: Assistant[]) {
  const [path, query] = window.location.hash.replace(/^#/, '').split('?')
  if (path !== 'assistant/calendar' && path !== 'assistant/booking') return
  let id: string | null = null
  try {
    id = sessionStorage.getItem(CONNECT_RETURN_KEY)
    sessionStorage.removeItem(CONNECT_RETURN_KEY)
  } catch {}
  const assistant = assistants.find(a => a.id === id) ?? assistants[0]
  if (assistant) history.replaceState(null, '', `#assistant/${assistant.id}/booking${query ? `?${query}` : ''}`)
}

/**
 * Old and short links in place: `#assistant/<section>` (no assistant) goes to the first assistant, and a
 * section id from before the regrouping (`greeting`, `knowledge`, `transfer`, `calendar`, `emergencies`) to its new one.
 */
function canonicalAssistantHash(assistants: Assistant[]) {
  const [path = '', query] = window.location.hash.replace(/^#/, '').split('?')
  const [page, ...parts] = path.split('/')
  if (page !== 'assistant' || !parts.length) return
  const isAssistant = assistants.some(a => a.id === parts[0])
  const id = isAssistant ? parts[0]! : assistants[0]?.id
  const section = isAssistant ? parts[1] : parts[0]
  if (!id || !section) return
  // Notifications are your own settings now (Settings › Notifications), not the assistant's.
  if (section === 'notifications') return history.replaceState(null, '', `#settings/notifications${query ? `?${query}` : ''}`)
  const next = OLD_SECTIONS[section] ?? section
  if (isAssistant && next === section) return
  history.replaceState(null, '', `#assistant/${id}/${next}${query ? `?${query}` : ''}`)
}

/** The assistant the hash names (`#assistant/<id>/<section>`), else the workspace's first. */
function assistantInHash(assistants: Assistant[]): Assistant | undefined {
  const [, id] = window.location.hash.replace(/^#/, '').split('?')[0]!.split('/')
  return assistants.find(a => a.id === id) ?? assistants[0]
}

/** Whether the workspace uses business hours (Settings, Business hours): then greeting and instructions get an outside variant. */
const useBusinessHoursOn = (): boolean => useWorkspaceSettings().data?.businessHoursOn ?? false

/** Before the assistants first arrive on this device: the page's frame, never "No assistant yet". */
function AssistantSkeleton({ slow }: { slow: boolean }) {
  if (slow) return <LoadProblem what="The assistant" />
  return (
    <SettingsLayout
      page="assistant"
      title="Assistant"
      heading={<Skeleton className="sk-title" />}
      sections={sections}
      current={sections[0]!.id}
    >
      <Skeleton className="sk-card" />
    </SettingsLayout>
  )
}

export function AssistantSettings(props: Props) {
  const assistants = useAssistants()
  const loadState = useLoadState('assistants')
  const numbers = useRows('phone_numbers').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [, rerender] = useState(0)
  useEffect(() => {
    const onHash = () => rerender(n => n + 1)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (assistants.length) {
    returnFromCalendarConnect(assistants)
    canonicalAssistantHash(assistants)
  }
  const assistant = assistantInHash(assistants)
  const onPick = useCallback((id: string) => {
    window.location.hash = `#assistant/${id}/${sections[0]!.id}`
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
      ) : loadState !== 'ready' ? (
        <AssistantSkeleton slow={loadState === 'slow'} />
      ) : (
        <div className="empty">
          <b>No assistant yet</b>
        </div>
      )}
    </div>
  )
}
