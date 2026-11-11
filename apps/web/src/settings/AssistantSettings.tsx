// Assistant settings: name, greeting, AI disclosure, voice, the business's instructions, call rules,
// transfer contacts and the calendar, one section at a time (#assistant/<id>/<section>). Edits in the text sections are one local
// draft: Save runs assistant.update through the outbox; a section with unsaved
// changes keeps a dot in the nav while you look at another one.
import { type AssistantLanguages, CALL_RULES_MAX, CALLER_LANGUAGES, type CallerLanguage, callerLanguageCodes, DEFAULT_CALL_RULES, DEFAULT_KNOWN_CALLER_GREETING, knownCallerGreetingProblem, SILENCE_CLOSING_MAX, KEYPAD_MENU_LABEL_MAX, KEYPAD_MENU_MAX_OPTIONS } from '@linedesk/actions'
import type { Assistant, KeypadMenuAction, KeypadMenuOption, PhoneNumber } from '@linedesk/db/types'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renameInGreeting } from '../onboarding/flow.ts'
import { useAssistants, useRows, useRun } from '../store.tsx'
import { onSaveKey, SaveBar } from '../ui/form.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { LoadProblem, Skeleton, useLoadState } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, sectionHash, useSection } from '../ui/SettingsLayout.tsx'
import {
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
  withDisclosure,
  withoutDisclosure,
} from './assistantDraft.ts'
import { AssistantHeader } from './AssistantHeader.tsx'
import { CalendarSettings } from './Calendar.tsx'
import { CONNECT_RETURN_KEY } from './calendarModel.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { Field, Section, SwitchRow, TextArea, TextInput, useRemembered } from './fields.tsx'
import { useWorkspaceSettings } from './settings-api.ts'
import { Knowledge } from './Knowledge.tsx'
import { VoiceSettings } from './VoiceSettings.tsx'
import { TestCallButton, useTestCall } from './TestCall.tsx'
import { TestCallPanel } from './TestCallPanel.tsx'
import { TransferContacts, transferFieldId } from './TransferContacts.tsx'

type SectionId = 'greeting' | 'voice' | 'knowledge' | 'rules' | 'transfer' | 'calendar' | 'advanced'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'greeting', label: 'Greeting', description: 'First sentence, returning callers, AI disclosure' },
  { id: 'voice', label: 'Voice', description: 'How the assistant sounds' },
  { id: 'knowledge', label: 'Knowledge', description: 'Your business, services, prices and FAQs' },
  { id: 'rules', label: 'Call rules', description: 'How calls are handled' },
  { id: 'transfer', label: 'Transfers', description: 'Who callers are put through to, and when' },
  { id: 'calendar', label: 'Calendar', description: 'Accounts, calendars and appointment types' },
  { id: 'advanced', label: 'Advanced', description: 'Languages, silence on the line, keypad menu' },
]
/** Which draft fields each section holds; the calendar has its own. */
const sectionFields: Record<Exclude<SectionId, 'calendar'>, (keyof Draft)[]> = {
  greeting: ['name', 'greeting', 'disclose_ai', 'greeting_known_caller', 'greeting_outside'],
  voice: ['voice'],
  knowledge: ['instructions', 'services', 'faqs', 'website'],
  rules: ['call_rules'],
  transfer: ['transfers'],
  advanced: ['silence_first_gap_s', 'silence_reminders', 'silence_closing', 'keypad_on', 'keypad_options', 'languages'],
}

/** The assistant's name as the help texts say it, also while the name field is being edited. */
const assistantName = (draft: Draft) => draft.name.trim() || 'The assistant'

type SectionProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }
const count = (n: number) => n.toLocaleString('en-US')

/** Whether the greeting's Advanced part is open; remembered in this browser. */
const GREETING_ADVANCED_KEY = 'linedesk.assistant.greeting-advanced'

function Greeting({
  draft,
  set,
  renamedFrom,
  hoursOn,
  canEdit,
}: SectionProps & { renamedFrom: string | null; hoursOn: boolean; canEdit: boolean }) {
  const stale = renamedFrom ? staleGreetingName(draft.greeting, renamedFrom, draft.name) : null
  const knownProblem = knownCallerGreetingProblem(draft.greeting_known_caller)
  const [remembered, remember] = useRemembered(GREETING_ADVANCED_KEY)
  // A problem in there shows it open, so the error is never hidden.
  const advancedOpen = remembered || !!knownProblem
  /** The switch and the greeting say the same thing: turning it on or off adds or removes the disclosure. */
  function disclose(on: boolean) {
    set('disclose_ai', on)
    set('greeting', on ? withDisclosure(draft.greeting, draft.name) : withoutDisclosure(draft.greeting))
  }
  return (
    <Section id="as-greeting" title="Greeting">
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
      <details className="vp-more" open={advancedOpen} onToggle={e => remember(e.currentTarget.open)}>
        <summary title="Returning callers, outside hours, AI disclosure">
          <Icon name="down" size={14} className="vp-chevron" />
          Advanced
        </summary>
        <div className="vp-more-body">
          <Field id="as-greet-known" label="Returning callers" aside="Optional" error={knownProblem}>
            <TextInput
              id="as-greet-known"
              value={draft.greeting_known_caller}
              onChange={v => set('greeting_known_caller', v)}
              placeholder={DEFAULT_KNOWN_CALLER_GREETING}
              invalid={!!knownProblem}
            />
            <span className="help">
              {draft.greeting_known_caller.trim()
                ? 'Said before the greeting when a saved contact calls again. {first_name} is their first name.'
                : 'Empty: returning callers hear the usual greeting.'}
            </span>
          </Field>
          {hoursOn && (
            <Field id="as-greet-out" label="Outside business hours" aside="Optional">
              <TextArea
                id="as-greet-out"
                value={draft.greeting_outside}
                onChange={v => set('greeting_outside', v)}
                placeholder={draft.greeting}
              />
              <span className="help">
                {draft.greeting_outside.trim() ? spokenLength(draft.greeting_outside) : 'Empty: the same as during hours.'}
              </span>
              <span className="as-hours-line">
                <EditBusinessHours canEdit={canEdit} />
              </span>
            </Field>
          )}
          <SwitchRow
            title="Say it's an AI assistant"
            description={draft.disclose_ai ? undefined : 'Some states require it.'}
            on={draft.disclose_ai}
            onChange={disclose}
          />
        </div>
      </details>
    </Section>
  )
}

function CallRules({ draft, set }: SectionProps) {
  const isDefault = isDefaultCallRules(draft)
  return (
    <Section
      id="as-rules"
      title="Call rules"
      help={`How ${assistantName(draft)} handles a call: what to ask, what to do with emergencies, prices and sales calls. Whatever the rules say, ${assistantName(draft)} always says it is an AI when asked and offers to take a message when it can't help.`}
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

const languageModes: { value: AssistantLanguages['mode']; label: string; description: string }[] = [
  { value: 'english', label: 'English only', description: 'Other languages: answered in English, with an offer to take a message' },
  { value: 'allowed', label: 'English and the languages you pick', description: 'Switches only to these' },
  { value: 'any', label: 'Any language it speaks', description: 'Every language listed below' },
]

function Languages({ draft, set }: SectionProps) {
  const { mode, allowed } = draft.languages
  const problem = languagesProblem(draft)
  const toggle = (code: CallerLanguage, on: boolean) =>
    set('languages', { mode, allowed: callerLanguageCodes.filter(c => (c === code ? on : allowed.includes(c))) })
  return (
    <Section
      id="as-languages"
      title="Languages"
      help={`${assistantName(draft)} greets in English. When a caller speaks a language you allow, it answers in that language from then on; otherwise it goes on in English. Summaries are always in English, transcripts stay in the language spoken. Same price per minute; the first reply after a switch can take a moment longer.`}
    >
      <Select id="as-languages-mode" label="Languages" value={mode} options={languageModes} onChange={m => set('languages', { mode: m, allowed })} />
      {mode !== 'english' && (
        <div className="as-languages" role="group" aria-label="Languages besides English">
          {callerLanguageCodes.map(code => (
            <Checkbox
              key={code}
              checked={mode === 'any' || allowed.includes(code)}
              disabled={mode === 'any'}
              onChange={on => toggle(code, on)}
            >
              {CALLER_LANGUAGES[code]}
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
      (Object.keys(sectionFields) as Exclude<SectionId, 'calendar'>[]).filter(id =>
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
    if (!draft.greeting.trim()) return goTo('greeting', 'as-greet')
    if (knownCallerGreetingProblem(draft.greeting_known_caller)) return goTo('greeting', 'as-greet-known')
    const transfer = transferProblem(draft)
    if (transfer) {
      setTransferSaveTried(true)
      return goTo('transfer', transferFieldId(transfer.index, transfer.field))
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
        disclose_ai: clean.disclose_ai,
        greeting_known_caller: clean.greeting_known_caller,
        business_profile: profileOf(clean),
        call_rules: callRulesToSave(clean),
        ...outsideToSave(clean),
        // Only when changed: putting calls through to a number waits for a confirmed email, other edits do not.
        ...(unsaved.has('transfer') ? { transfers: transfersToSave(clean) } : {}),
        ...silenceToSave(clean),
        ...keypadToSave(clean),
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
        banner={<TestCallPanel session={testCall} />}
        sections={sections}
        current={current}
        unsaved={unsaved}
      >
        <fieldset className="st-fields" disabled={!canEdit}>
          {current === 'greeting' && <Greeting draft={draft} set={set} renamedFrom={renamedFrom} hoursOn={hoursOn} canEdit={canEdit} />}
          {current === 'voice' && (
            <VoiceSettings
              assistantId={assistant.id}
              voice={draft.voice}
              onPick={v => set('voice', v)}
              canEdit={canEdit}
              toast={toast}
            />
          )}
          {current === 'knowledge' && (
            <Knowledge
              assistant={assistant}
              draft={draft}
              set={set}
              replace={setDraft}
              canEdit={canEdit}
              toast={toast}
            />
          )}
          {current === 'rules' && <CallRules draft={draft} set={set} />}
          {current === 'transfer' && (
            <TransferContacts
              transfers={draft.transfers}
              onChange={list => set('transfers', list)}
              hoursOn={hoursOn}
              assistantName={assistantName(draft)}
              showErrors={transferSaveTried}
            />
          )}
          {current === 'advanced' && (
            <>
              <Languages draft={draft} set={set} />
              <Advanced draft={draft} set={set} />
              <KeypadMenu draft={draft} set={set} />
            </>
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
