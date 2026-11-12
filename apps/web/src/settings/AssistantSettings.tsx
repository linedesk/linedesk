// Assistant settings by topic, one section at a time (#assistant/<id>/<section>): general (name, greeting,
// languages), business info, hours and holidays, rules (AI disclosure, tone, behaviour checklist), transfers
// (transfer contacts), booking, voice, and Advanced (silence on the line).
// The assistant's own fields are one local draft: Save runs assistant.update through the outbox; a section
// with unsaved changes keeps a dot in the nav. Hours, holidays and booking save on their own.
import { AI_DISCLOSURE_LABELS, AI_DISCLOSURE_MODES, type AiDisclosure, BEHAVIOURS, COMMUNICATION_STYLE_LABELS, COMMUNICATION_STYLES, disclosesAtStart, greetingWithDisclosure, withDisclosure, withoutDisclosure, DEFAULT_SILENCE_REMINDER, TALKING_SPEED_PCT_DEFAULT, TALKING_SPEED_PCT_MAX, TALKING_SPEED_PCT_MIN, talkingSpeedLabel, type AssistantLanguages, type Language, languageCodes, LANGUAGES } from '@linedesk/actions'
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
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
  outsideToSave,
  type Draft,
  draftOf,
  draftProblem,
  isDirty,
  keepDraft,
  languagesProblem,
  languagesToSave,
  mainOf,
  pickedOthers,
  withMainLanguage,
  keptDraft,
  mergeDraft,
  normalized,
  profileOf,
  silenceProblem,
  hangUpSummary,
  silenceSummary,
  silenceToSave,
  spokenLength,
  nameProblem,
  staleGreetingName,
  transferProblem,
  transfersToSave,
} from './assistantDraft.ts'
import { AssistantHeader } from './AssistantHeader.tsx'
import { CalendarSettings } from './Calendar.tsx'
import { CONNECT_RETURN_KEY } from './calendarModel.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { Field, Section, SelectRow, SwitchRow, TextArea, TextInput } from './fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { Knowledge } from './Knowledge.tsx'
import { loadCatalog, VoiceSettings } from './VoiceSettings.tsx'
import { voiceForMainLanguage } from './voiceModel.ts'
import { TestCallButton, useTestCall } from './TestCall.tsx'
import { TestCallPanel } from './TestCallPanel.tsx'
import { TransferContacts, transferFieldId } from './TransferContacts.tsx'
import { BusinessHours, TimeZoneSelect } from './BusinessHours.tsx'
import { Holidays, VacationMode } from './Holidays.tsx'
import { Webhooks } from './Webhooks.tsx'

type SectionId = 'general' | 'business' | 'hours' | 'rules' | 'transfers' | 'booking' | 'webhooks' | 'advanced'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'general', label: 'General', description: 'Name, greeting, languages and voice' },
  { id: 'business', label: 'Business info', description: 'What you do, your prices and what callers ask' },
  { id: 'hours', label: 'Hours & holidays', description: 'Weekly hours, holidays, vacation mode' },
  { id: 'rules', label: 'Rules', description: 'AI disclosure, tone and how calls are handled' },
  { id: 'transfers', label: 'Transfers', description: 'Who calls are put through to' },
  { id: 'booking', label: 'Booking & Calendar', description: 'Calendars and appointment types' },
  { id: 'webhooks', label: 'Webhook', description: 'Your system at the start of a call and after it' },
  { id: 'advanced', label: 'Advanced', description: 'Talking speed, time zone, silence, hanging up' },
]
/** Sections that save on their own, outside the assistant's draft. */
type OwnSection = 'hours' | 'booking' | 'webhooks'
/** Which draft fields each section holds. */
const sectionFields: Record<Exclude<SectionId, OwnSection>, (keyof Draft)[]> = {
  business: ['instructions', 'website'],
  general: ['name', 'greeting', 'greeting_outside', 'languages', 'voice'],
  rules: ['ai_disclosure', 'communication_style', 'behaviours'],
  transfers: ['transfers'],
  advanced: ['talking_speed_pct', 'silence_first_gap_s', 'silence_reminders', 'silence_hang_up_s', 'max_call_minutes', 'silence_reminder', 'silence_closing'],
}
/** Section ids from before the regrouping, so old links and bookmarks still land in the right place. */
const OLD_SECTIONS: Record<string, SectionId> = {
  greeting: 'general',
  knowledge: 'business',
  transfer: 'transfers',
  calls: 'transfers',
  calendar: 'booking',
  emergencies: 'transfers',
  voice: 'general',
}

/** The assistant's name as the help texts say it, also while the name field is being edited. */
const assistantName = (draft: Draft) => draft.name.trim() || 'The assistant'

type SectionProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }

/**
 * An optional greeting field: shown while it has text or was just added here; added with a starting text and
 * focused, removed by emptying it (empty means "not used" when saved). Hidden until added, so the section
 * starts with the one greeting every caller hears.
 */
function useOptionalGreeting(value: string, clear: () => void, start: () => void, fieldId: string) {
  const [added, setAdded] = useState(false)
  const shown = added || value.trim() !== ''
  // Emptied from outside the field (Cancel): it goes away; emptied by typing in it, it stays.
  useEffect(() => {
    if (!value.trim() && document.activeElement?.id !== fieldId) setAdded(false)
  }, [value, fieldId])
  const add = () => {
    start()
    setAdded(true)
    setTimeout(() => document.getElementById(fieldId)?.focus(), 0)
  }
  const remove = () => {
    clear()
    setAdded(false)
  }
  return { shown, add, remove }
}

/** The quiet × next to an optional greeting's label. */
function RemoveGreeting({ what, onRemove }: { what: string; onRemove: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="close"
      className="as-greet-remove"
      aria-label={`Remove ${what}`}
      title={`Remove ${what}`}
      onClick={onRemove}
    />
  )
}

/** The assistant's name, saved with the rest of the draft; the menu at the top only switches assistants. */
function AssistantNameSection({ draft, set }: SectionProps) {
  const problem = nameProblem(draft.name)
  return (
    <Section id="as-name-section">
      <Field id="as-name" label="Assistant name" error={problem}>
        <TextInput id="as-name" value={draft.name} onChange={v => set('name', v)} invalid={!!problem} placeholder="Maya" />
      </Field>
    </Section>
  )
}

function Greeting({
  draft,
  set,
  savedName,
  hoursOn,
  canEdit,
}: SectionProps & { savedName: string; hoursOn: boolean; canEdit: boolean }) {
  const stale = staleGreetingName(draft.greeting, savedName, draft.name)
  const name = assistantName(draft)
  const outsideGreeting = useOptionalGreeting(
    draft.greeting_outside,
    () => set('greeting_outside', ''),
    () => set('greeting_outside', draft.greeting),
    'as-greet-out',
  )
  // Without business hours there is no "closed": the outside greeting is neither shown nor offered.
  const outsideShown = hoursOn && outsideGreeting.shown
  const canAddOutside = hoursOn && !outsideGreeting.shown
  return (
    <Section id="as-greeting">
      <Field
        id="as-greet"
        label={outsideShown ? 'First sentence greeting, during business hours' : 'First sentence greeting'}
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
      {outsideShown && (
        <Field
          id="as-greet-out"
          label="Outside business hours"
          labelAfter={<EditBusinessHours canEdit={canEdit} />}
          aside={
            <>
              {draft.greeting_outside.trim() && spokenLength(draft.greeting_outside)}
              <RemoveGreeting what="the greeting for outside business hours" onRemove={outsideGreeting.remove} />
            </>
          }
        >
          <TextArea
            id="as-greet-out"
            value={draft.greeting_outside}
            onChange={v => set('greeting_outside', v)}
            placeholder={draft.greeting}
          />
          {!draft.greeting_outside.trim() && <span className="help">Empty: the same greeting as during business hours.</span>}
        </Field>
      )}
      {canAddOutside && (
        <div className="as-greet-add">
          <Button size="sm" variant="ghost" icon="plus" onClick={outsideGreeting.add}>
            Different greeting when closed
          </Button>
        </div>
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
      help={`Each switch adds a sentence to ${assistantName(draft)}'s instructions.`}
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

const languageOptions = languageCodes.map(code => ({ value: code, label: LANGUAGES[code] }))
const alsoModes = (main: string): { value: AssistantLanguages['mode']; label: string; description: string }[] => [
  { value: 'english', label: 'None', description: `Other languages: answered in ${main}, with an offer to take a message` },
  { value: 'allowed', label: 'These languages', description: 'Switches only to the ones you pick' },
  { value: 'any', label: 'Any supported language', description: 'Every language listed below' },
]

function Languages({ draft, set, onMainLanguage }: SectionProps & { onMainLanguage: (code: Language) => void }) {
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
          <Select id="as-languages-main" label="Main language" value={main} options={languageOptions} onChange={onMainLanguage} />
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
      {/* An error, not a hint: Save is refused until it is fixed. */}
      {problem && (
        <span className="k-field-msg" role="alert">
          {problem}
        </span>
      )}
    </Section>
  )
}

/** How fast the assistant talks: a slider from 20% slower to 20% faster than the voice's own pace, Normal in the middle. */
function TalkingSpeedSection({ draft, set }: SectionProps) {
  const pct = draft.talking_speed_pct
  const label = talkingSpeedLabel(pct)
  return (
    <Section
      id="as-speed"
      title="Talking speed"
      help="Applies from the next call. Normal is the voice's own pace; arrow keys move the slider by 1%."
      actions={<span className={pct === TALKING_SPEED_PCT_DEFAULT ? 'as-speed-value' : 'as-speed-value is-changed'}>{label}</span>}
    >
      <div className="as-speed">
        <input
          id="as-speed-range"
          type="range"
          min={TALKING_SPEED_PCT_MIN}
          max={TALKING_SPEED_PCT_MAX}
          step={1}
          value={pct}
          aria-label="Talking speed"
          aria-valuetext={label}
          onChange={e => set('talking_speed_pct', Number(e.target.value))}
        />
        <div className="as-speed-stops">
          <span aria-hidden="true">Slower</span>
          <button
            type="button"
            className={pct === TALKING_SPEED_PCT_DEFAULT ? 'is-on' : undefined}
            disabled={pct === TALKING_SPEED_PCT_DEFAULT}
            title="Back to the voice's own pace"
            onClick={() => set('talking_speed_pct', TALKING_SPEED_PCT_DEFAULT)}
          >
            Normal
          </button>
          <span aria-hidden="true">Faster</span>
        </div>
      </div>
    </Section>
  )
}

/** The workspace's time zone: the date and time the assistant is told, and what business hours mean. Saves at once. */
function TimeZoneSection({ canEdit }: { canEdit: boolean }) {
  const run = useRun()
  const settings = useWorkspaceSettings()
  const zone = settings.data?.timeZone
  const change = (timeZone: string) => {
    patchWorkspaceSettings({ timeZone })
    void run('workspace.updateSettings', { timeZone })
  }
  return (
    <Section id="as-time-zone" title="Time zone" help="The assistant is told today's date and the time in this zone. Business hours and bookings use it too. Saved at once, for every assistant of the workspace.">
      <Field id="as-time-zone-select" label="Where the business is">
        {zone ? <TimeZoneSelect id="as-time-zone-select" value={zone} onChange={change} disabled={!canEdit} /> : <span className="help">Loading…</span>}
      </Field>
    </Section>
  )
}

function Advanced({ draft, set }: SectionProps) {
  const problem = silenceProblem(draft)
  const errorFor = (start: string) => (problem?.startsWith(start) ? problem : null)
  const name = assistantName(draft)
  return (
    <>
      <Section id="as-advanced" title="Silence on the line" help={`When nobody speaks, ${name} asks whether the caller is still there, again after the same wait.`}>
        <div className="as-silence-row">
          <Field id="as-silence-gap" label="Ask after, seconds" error={errorFor('The first wait')}>
            <TextInput id="as-silence-gap" value={draft.silence_first_gap_s} onChange={v => set('silence_first_gap_s', v)} />
          </Field>
          <Field id="as-silence-times" label="Times to ask" error={errorFor('Ask')}>
            <TextInput id="as-silence-times" value={draft.silence_reminders} onChange={v => set('silence_reminders', v)} />
          </Field>
        </div>
        <Field id="as-silence-reminder" label="What it asks" error={errorFor('The reminder')}>
          <TextInput id="as-silence-reminder" value={draft.silence_reminder} onChange={v => set('silence_reminder', v)} placeholder={DEFAULT_SILENCE_REMINDER} />
        </Field>
        <span className="help">{silenceSummary(draft)}</span>
      </Section>
      <Section id="as-hang-up" title="Hanging up" help={`${name} ends a call itself when the line stays silent, or when the call gets too long (what the assistant costs). Never once a call was put through to a person.`}>
        <div className="as-silence-row">
          <Field id="as-silence-hang-up" label="After silence, seconds" error={errorFor('Hang up')}>
            <TextInput id="as-silence-hang-up" value={draft.silence_hang_up_s} onChange={v => set('silence_hang_up_s', v)} />
          </Field>
          <Field id="as-max-call" label="Longest call, minutes" error={errorFor('The longest call')}>
            <TextInput id="as-max-call" value={draft.max_call_minutes} onChange={v => set('max_call_minutes', v)} />
          </Field>
        </div>
        <Field id="as-silence-closing" label="What it says before hanging up" error={errorFor('The closing')}>
          <TextArea id="as-silence-closing" value={draft.silence_closing} onChange={v => set('silence_closing', v)} />
        </Field>
        <span className="help">{hangUpSummary(draft)}</span>
      </Section>
    </>
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
    // Name and greeting show their error under the field: go there instead of a toast that outlives the fix.
    if (nameProblem(draft.name)) return goTo('general', 'as-name')
    if (!draft.greeting.trim()) return goTo('general', 'as-greet')
    const transfer = transferProblem(draft)
    if (transfer) {
      setTransferSaveTried(true)
      return goTo('transfers', transferFieldId(transfer.index, transfer.field))
    }
    if (silenceProblem(draft)) return goTo('advanced', 'as-silence-gap')
    if (languagesProblem(draft)) return goTo('general', 'as-languages-mode')
    const problem = draftProblem(draft)
    if (problem) return toast(problem)
    if (dirty) {
      const clean = normalized(draft)
      void run('assistant.update', {
        assistantId: assistant.id,
        name: clean.name,
        greeting: clean.greeting,
        ai_disclosure: clean.ai_disclosure,
        communication_style: clean.communication_style,
        // For a web app of the release before, which still shows the switch.
        disclose_ai: disclosesAtStart(clean.ai_disclosure),
        business_profile: profileOf(clean),
        ...outsideToSave(clean),
        // Only when changed: putting calls through to a number waits for a confirmed email, other edits do not.
        ...(JSON.stringify(clean.transfers) !== JSON.stringify(normalized(saved).transfers) ? { transfers: transfersToSave(clean) } : {}),
        ...silenceToSave(clean),
        behaviours: behavioursToSave(clean),
        ...languagesToSave(clean),
        voice: clean.voice,
        talking_speed_pct: clean.talking_speed_pct,
      })
      setDraft(clean) // the form shows what was saved, so it is not "dirty" any more
    }
    toast('Assistant settings saved.')
  }
  /**
   * A new main language: its default texts, and a voice made for it when the providers have one (back to the
   * default voice for English). The voice comes from the catalog, so it follows a moment later, with a toast.
   */
  async function changeMainLanguage(code: Language) {
    setDraft(d => withMainLanguage(d, code))
    const catalog = await loadCatalog().catch(() => null)
    if (!catalog) return
    const active = catalog.providers.find(p => p.active)?.provider ?? null
    const next = voiceForMainLanguage(catalog.voices, code, draft.voice, active)
    if (!next || (next === 'default' && !active)) return
    const voice = next === 'default' ? { provider: active!, voice_id: '' } : { provider: next.provider, voice_id: next.id }
    // Only while that language is still the one picked: a quick second change wins.
    setDraft(d => (mainOf(d) === code ? { ...d, voice } : d))
    toast(next === 'default' ? 'Voice changed to the default voice, for English. Save to keep it.' : `Voice changed to ${next.name}, a ${LANGUAGES[code]} voice. Save to keep it.`)
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
          <>
            <AssistantNameSection draft={draft} set={set} />
            <Greeting draft={draft} set={set} savedName={assistant.name} hoursOn={hoursOn} canEdit={canEdit} />
            <Languages draft={draft} set={set} onMainLanguage={code => void changeMainLanguage(code)} />
            <VoiceSettings
              assistantId={assistant.id}
              voice={draft.voice}
              onPick={v => set('voice', v)}
              canEdit={canEdit}
              toast={toast}
              language={mainOf(draft)}
              assistantName={assistantName(draft)}
            />
          </>
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
        {current === 'advanced' && (
          <>
            <TalkingSpeedSection draft={draft} set={set} />
            <TimeZoneSection canEdit={canEdit} />
            <Advanced draft={draft} set={set} />
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
      ) : current === 'webhooks' ? (
        <Webhooks assistantId={assistant.id} canEdit={canEdit} toast={toast} />
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
