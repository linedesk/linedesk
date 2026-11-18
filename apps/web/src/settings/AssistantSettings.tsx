// Assistant settings by topic, one section at a time (#assistant/<id>/<section>): general (name, greeting,
// languages), How <name> did (owners and admins: calls to look at and questions to answer), business info, hours
// and holidays, rules (AI disclosure, tone, behaviour checklist), transfers (transfer contacts), call emails (who gets
// the email about which call, CallEmails.tsx), booking, voice and call quality, and Advanced (talking speed, silence on the line).
// The assistant's own fields are one local draft: Save runs assistant.update through the outbox; a section
// with unsaved changes keeps a dot in the nav. Hours, holidays and booking save on their own.

import {
  AI_DISCLOSURE_MODES,
  type AiDisclosure,
  type AssistantLanguages,
  aiDisclosureRisk,
  answeredQuestionLine,
  BEHAVIOURS,
  type BehaviourId,
  COMMUNICATION_STYLES,
  type CommunicationStyle,
  DEFAULT_SILENCE_REMINDER,
  disclosesAtStart,
  greetingWithDisclosure,
  type Language,
  mainLanguageOf,
  otherLanguagesOf,
  phoneCountryName,
  type PipelinesSetUp,
  TALKING_SPEED_PCT_DEFAULT,
  TALKING_SPEED_PCT_MAX,
  TALKING_SPEED_PCT_MIN,
  templateNames,
  type VoiceOptionsData,
  withDisclosure,
  withoutConsentQuestion,
  withoutDisclosure,
} from '@linedesk/actions'
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { languageInSentence, languageLabel, type MessageKey, msg } from '@linedesk/i18n'
import { T, useFormat, useLocale, useT } from '@linedesk/i18n/react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { renameInGreeting } from '../onboarding/flow.ts'
import { useOutboundCountries } from '../onboarding/outbound-number.ts'
import { AssistantReview } from '../review/AssistantReview.tsx'
import { loadReviewList, reviewListKey } from '../review/reviewData.ts'
import { REVIEW_SECTION, reviewTitle } from '../review/reviewModel.ts'
import { useAssistants, useRows, useRun } from '../store.tsx'
import { appLink } from '../ui/AppLink.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { onSaveKey, SaveBar } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, LoadProblem, Skeleton, useLoading, useLoadState } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, sectionHash, useSection } from '../ui/SettingsLayout.tsx'
import { useWorkspaceCountry, useWorkspaceLanguage } from '../workspaceLocale.ts'
import { AgentChangeNote } from './AgentChange.tsx'
import { AssistantHeader } from './AssistantHeader.tsx'
import {
  behavioursToSave,
  type Draft,
  draftOf,
  draftProblem,
  hangUpSummary,
  isDirty,
  keepDraft,
  keptDraft,
  languagesProblem,
  languagesToSave,
  levelChoicesToSave,
  mainOf,
  mergeDraft,
  nameProblem,
  normalized,
  offeredLanguages,
  outsideToSave,
  pickedOthers,
  profileOf,
  type SilenceField,
  silenceIssue,
  silenceProblem,
  silenceSummary,
  silenceToSave,
  spokenLength,
  staleGreetingName,
  transferProblem,
  transfersToSave,
  withMainLanguage,
  withPickedVoice,
} from './assistantDraft.ts'
import { BusinessHours } from './BusinessHours.tsx'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { CalendarSettings } from './Calendar.tsx'
import { CallEmails, emailRuleWhenId, type Undoable } from './CallEmails.tsx'
import { CallQualitySettings, levelSavedNote } from './CallQuality.tsx'
import { CONNECT_RETURN_KEY } from './calendarModel.ts'
import {
  Field,
  FollowsLine,
  ReadOnlyNote,
  Section,
  SelectRow,
  SkeletonSection,
  SwitchRow,
  TextArea,
  TextInput,
} from './fields.tsx'
import { Holidays, VacationMode } from './Holidays.tsx'
import { Knowledge } from './Knowledge.tsx'
import { MissingProviderNote } from './MissingProviderNote.tsx'
import { HoursSummary, RulesSummary, TransfersSummary } from './Summaries.tsx'
import { useWorkspaceSettings } from './settings-api.ts'
import { TestCallButton, useTestCall } from './TestCall.tsx'
import { TestCallPanel } from './TestCallPanel.tsx'
import { TransferContacts, transferFieldId } from './TransferContacts.tsx'
import { RealtimeVoiceSettings, useVoiceOptions, VoiceLoading, VoiceSettings } from './VoiceSettings.tsx'
import { Webhooks } from './Webhooks.tsx'

type SectionId =
  | 'general'
  | 'review'
  | 'business'
  | 'hours'
  | 'rules'
  | 'transfers'
  | 'emails'
  | 'booking'
  | 'webhooks'
  | 'advanced'
const SECTION_IDS: readonly SectionId[] = [
  'general',
  // Named after the assistant on the page (sectionsFor); owners and admins only.
  'review',
  'business',
  'hours',
  'rules',
  'transfers',
  'emails',
  'booking',
  'webhooks',
  'advanced',
]
/** Each section's name and line in the nav, in the active language. */
// i18n-dynamic: settings.assistant.section.*
const sectionsIn = (t: ReturnType<typeof useT>): readonly PageSection<SectionId>[] =>
  SECTION_IDS.map(id => ({
    id,
    label: t(`settings.assistant.section.${id}.label`),
    description: t(`settings.assistant.section.${id}.description`),
  }))

/**
 * The sections this member sees: How <name> did only for owners and admins (it reads evaluations), named after the
 * assistant, with its open calls and questions as a count.
 */
function sectionsFor(
  sections: readonly PageSection<SectionId>[],
  name: string,
  canEdit: boolean,
  openItems: number,
): readonly PageSection<SectionId>[] {
  return sections
    .filter(s => s.id !== REVIEW_SECTION || canEdit)
    .map(s => (s.id === REVIEW_SECTION ? { ...s, label: reviewTitle(name), count: openItems } : s))
}

/**
 * Which pipelines this workspace may use (voice.options: those set up, narrowed to the instance admin's pick); null
 * while not known, and from an API of an older version (during an update), which only says whether a realtime model
 * is connected: then nothing is said about them.
 */
const pipelinesOf = (options: VoiceOptionsData | undefined): PipelinesSetUp | null => options?.pipelines ?? null

/** Neither way of answering is set up (known once the options came). */
const nothingAnswers = (setUp: PipelinesSetUp | null) => !!setUp && !setUp.realtime && !setUp.three_stage

/** Neither way of answering is set up: said in General, where the assistant is set up, not tucked away in Advanced. */
function NotAnswered({ setUp }: { setUp: PipelinesSetUp | null }) {
  const t = useT()
  if (!nothingAnswers(setUp)) return null
  return (
    <Section id="as-not-answered" title={t('settings.assistant.answering.title')}>
      <MissingProviderNote kind="answering" />
    </Section>
  )
}

/** Sections that save on their own, outside the assistant's draft. */
type OwnSection = 'hours' | 'booking' | 'webhooks' | 'review'
/** Which draft fields each section holds. */
const sectionFields: Record<Exclude<SectionId, OwnSection>, (keyof Draft)[]> = {
  business: ['instructions', 'website'],
  general: [
    'name',
    'greeting',
    'greeting_outside',
    'languages',
    'main_language_follows',
    'call_quality',
    'voice',
    'llm_model',
    'realtime_voice',
    'realtime_model',
  ],
  rules: ['ai_disclosure', 'communication_style', 'behaviours'],
  transfers: ['transfers'],
  emails: ['email_rules'],
  advanced: [
    'talking_speed_pct',
    'silence_first_gap_s',
    'silence_reminders',
    'silence_hang_up_s',
    'max_call_minutes',
    'silence_reminder',
    'silence_closing',
    'goodbye_line',
  ],
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
const assistantName = (draft: Draft, t: ReturnType<typeof useT>) =>
  draft.name.trim() || t('settings.assistant.name.fallback')
/** The name inside a sentence: "The tone Maya uses", or "your assistant" before it has one. */
const nameInSentence = (draft: Draft, t: ReturnType<typeof useT>) =>
  draft.name.trim() || t('settings.assistant.name.inSentence')

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
function RemoveGreeting({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="close"
      className="as-greet-remove"
      aria-label={label}
      title={label}
      onClick={onRemove}
    />
  )
}

/** The assistant's name, saved with the rest of the draft; the menu at the top only switches assistants. */
function AssistantNameSection({ draft, set }: SectionProps) {
  const t = useT()
  const problem = nameProblem(draft.name)
  return (
    <Section id="as-name-section">
      <Field id="as-name" label={t('settings.assistant.name.label')} error={problem}>
        <TextInput
          id="as-name"
          value={draft.name}
          onChange={v => set('name', v)}
          invalid={!!problem}
          placeholder="Maya"
        />
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
  const t = useT()
  const stale = staleGreetingName(draft.greeting, savedName, draft.name)
  const name = assistantName(draft, t)
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
        label={t(outsideShown ? 'settings.assistant.greeting.labelDuringHours' : 'settings.assistant.greeting.label')}
        aside={draft.greeting.trim() ? spokenLength(draft.greeting) : undefined}
        error={draft.greeting.trim() ? null : t('settings.assistant.greeting.empty')}
      >
        <TextArea
          id="as-greet"
          value={draft.greeting}
          onChange={v => set('greeting', v)}
          invalid={!draft.greeting.trim()}
          placeholder={t('settings.assistant.greeting.placeholder', { name })}
        />
        <CallerDetailsHint greeting={draft.greeting} />
        {stale && (
          <span className="help as-stale">
            {t('settings.assistant.greeting.stale', { name: stale })}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set('greeting', renameInGreeting(draft.greeting, stale, draft.name.trim()))}
            >
              {t('settings.assistant.greeting.useName', { name: draft.name.trim() })}
            </Button>
          </span>
        )}
      </Field>
      {outsideShown && (
        <Field
          id="as-greet-out"
          label={t('settings.assistant.greeting.outside')}
          labelAfter={<EditBusinessHours canEdit={canEdit} />}
          aside={
            <>
              {draft.greeting_outside.trim() && spokenLength(draft.greeting_outside)}
              <RemoveGreeting
                label={t('settings.assistant.greeting.removeOutside')}
                onRemove={outsideGreeting.remove}
              />
            </>
          }
        >
          <TextArea
            id="as-greet-out"
            value={draft.greeting_outside}
            onChange={v => set('greeting_outside', v)}
            placeholder={draft.greeting}
          />
          {!draft.greeting_outside.trim() && (
            <span className="help">{t('settings.assistant.greeting.outsideEmpty')}</span>
          )}
          <CallerDetailsHint greeting={draft.greeting_outside} />
        </Field>
      )}
      {canAddOutside && (
        <div className="as-greet-add">
          <Button size="sm" variant="ghost" icon="plus" onClick={outsideGreeting.add}>
            {t('settings.assistant.greeting.addOutside')}
          </Button>
        </div>
      )}
    </Section>
  )
}

/**
 * A greeting with caller details from the webhook ({{name}}) says them before the caller has told who they are, and
 * caller ID can be faked: the owner should only put in what anyone calling from that number may hear.
 */
function CallerDetailsHint({ greeting }: { greeting: string }) {
  const t = useT()
  if (!templateNames(greeting).length) return null
  return <span className="help">{t('settings.assistant.greeting.callerDetails')}</span>
}

/** The behaviour checklist: plain-language switches that add a line to the assistant's instructions. */
function Behaviours({ draft, set }: SectionProps) {
  const t = useT()
  return (
    <Section
      id="as-behaviour"
      title={t('settings.assistant.rules.title')}
      description={t('settings.assistant.rules.description')}
      help={t('settings.assistant.rules.help', { name: assistantName(draft, t) })}
    >
      <div className="as-checklist">
        <AiDisclosureRow draft={draft} set={set} />
        <SelectRow
          id="as-style"
          title={t('settings.assistant.rules.style')}
          description={t('settings.assistant.rules.styleDescription', { name: nameInSentence(draft, t) })}
          value={draft.communication_style}
          options={COMMUNICATION_STYLES.map(style => ({ value: style, label: t(STYLE_LABELS[style]) }))}
          onChange={style => set('communication_style', style)}
        />
        {BEHAVIOURS.map(b => (
          <SwitchRow
            key={b.id}
            title={t(BEHAVIOUR_LABELS[b.id])}
            aside={draft.behaviours[b.id] === b.on ? undefined : t('settings.assistant.rules.changed')}
            on={draft.behaviours[b.id]}
            onChange={on => set('behaviours', { ...draft.behaviours, [b.id]: on })}
          />
        ))}
      </div>
    </Section>
  )
}

/** The checklist's switches as the page names them. */
const BEHAVIOUR_LABELS: Record<BehaviourId, MessageKey> = {
  ask_name: msg('settings.assistant.behaviour.askName'),
  offer_callback: msg('settings.assistant.behaviour.offerCallback'),
  confirm_number: msg('settings.assistant.behaviour.confirmNumber'),
  caller_history: msg('settings.assistant.behaviour.callerHistory'),
  ask_booking_name: msg('settings.assistant.behaviour.askBookingName'),
  verified_caller_only: msg('settings.assistant.behaviour.verifiedCallerOnly'),
}
const DISCLOSURE_LABELS: Record<AiDisclosure, MessageKey> = {
  never_confirm: msg('settings.assistant.disclosure.neverConfirm'),
  never: msg('settings.assistant.disclosure.never'),
  when_asked: msg('settings.assistant.disclosure.whenAsked'),
  at_start: msg('settings.assistant.disclosure.atStart'),
  at_start_consent: msg('settings.assistant.disclosure.atStartConsent'),
}
const STYLE_LABELS: Record<CommunicationStyle, MessageKey> = {
  standard: msg('settings.assistant.style.standard'),
  professional: msg('settings.assistant.style.professional'),
  casual: msg('settings.assistant.style.casual'),
  formal: msg('settings.assistant.style.formal'),
  empathetic: msg('settings.assistant.style.empathetic'),
}

/**
 * AI disclosure, the first row of the checklist. Picking a mode that says it at the start writes the note (and in
 * the consent mode the consent question) into the greeting, where the owner can edit it; the call says the greeting
 * as saved. The other modes take them out. Every mode can be picked anywhere (the owner decides: personal use, demos);
 * a mode that may break the law where the workspace is gets a hint, and "not even when asked" a warning
 * (aiDisclosureRisk; legal review 2026-11-17, A2).
 */
export function AiDisclosureRow({ draft, set }: SectionProps) {
  const t = useT()
  const risk = aiDisclosureRisk(draft.ai_disclosure, useWorkspaceSettings().data?.resolvedCountry)
  function pick(mode: AiDisclosure) {
    const language = mainOf(draft)
    const plain = withoutConsentQuestion(draft.greeting, language)
    set('ai_disclosure', mode)
    set(
      'greeting',
      mode === 'at_start_consent'
        ? greetingWithDisclosure(plain, draft.name, mode, language)
        : disclosesAtStart(mode)
          ? withDisclosure(plain, draft.name, language)
          : withoutDisclosure(plain, draft.name, language),
    )
  }
  const name = nameInSentence(draft, t)
  const heard = disclosesAtStart(draft.ai_disclosure) && draft.greeting.trim() ? draft.greeting.trim() : null
  const lawHint =
    risk.level === 'law'
      ? risk.eu
        ? t('settings.assistant.disclosure.lawEu')
        : t('settings.assistant.disclosure.lawUs')
      : null
  return (
    <>
      <SelectRow
        id="as-ai-disclosure"
        title={t('settings.assistant.disclosure.title')}
        description={t('settings.assistant.disclosure.description', { name })}
        note={heard ? t('settings.assistant.disclosure.heard', { greeting: heard }) : lawHint}
        value={draft.ai_disclosure}
        options={AI_DISCLOSURE_MODES.map(mode => ({ value: mode, label: t(DISCLOSURE_LABELS[mode]) }))}
        onChange={pick}
      />
      {risk.level === 'strong' && (
        <Note tone="warning">
          {risk.eu
            ? t('settings.assistant.disclosure.neverConfirmWarningEu', { name: assistantName(draft, t) })
            : t('settings.assistant.disclosure.neverConfirmWarning', { name: assistantName(draft, t) })}
        </Note>
      )}
    </>
  )
}

const alsoModes = (
  t: ReturnType<typeof useT>,
  main: string,
): { value: AssistantLanguages['mode']; label: string; description: string }[] => [
  {
    value: 'english',
    label: t('settings.assistant.languages.mode.none'),
    description: t('settings.assistant.languages.mode.noneDescription', { language: main }),
  },
  {
    value: 'allowed',
    label: t('settings.assistant.languages.mode.allowed'),
    description: t('settings.assistant.languages.mode.allowedDescription'),
  },
  {
    value: 'any',
    label: t('settings.assistant.languages.mode.any'),
    description: t('settings.assistant.languages.mode.anyDescription'),
  },
]

export function Languages({
  draft,
  set,
  onMainLanguage,
  onCountryLanguage,
  country,
  countryLanguage,
  installed,
  anyCovers,
}: SectionProps & {
  onMainLanguage: (code: Language) => void
  /** Back to following the workspace's country; none: can't change it (a member). */
  onCountryLanguage?: () => void
  /** The workspace's country in use, by name; null while it loads (no line yet). */
  country?: string | null
  /** The main language the country gives (mainLanguageOf with the workspace language). */
  countryLanguage?: Language
  installed?: readonly string[]
  /** What "Any supported language" covers on this install (voice.options anyLanguages); missing: every one offered. */
  anyCovers?: readonly string[]
}) {
  const ui = useLocale()
  const t = useT()
  const { mode } = draft.languages
  const main = mainOf(draft)
  const mainName = languageInSentence(main, ui)
  // Only languages a connected voice provider speaks (voice.options), and the ones already picked.
  const offered = offeredLanguages(installed, draft)
  // Each language in its own name and in the UI language ("Español · Spanish"), in the registry's order.
  const languageOptions = offered.map(code => ({ value: code, label: languageLabel(code, ui) }))
  const coveredByAny = (code: Language) => !anyCovers || anyCovers.includes(code)
  // With a Flux model "any" keeps Flux's languages; the others only when picked (coordinator decision on LIN-268).
  const anyLimited = mode === 'any' && offered.some(code => !coveredByAny(code))
  const others = pickedOthers(draft)
  const problem = languagesProblem(draft)
  const toggle = (code: Language, on: boolean) =>
    set('languages', {
      ...draft.languages,
      allowed: offered.filter(c => c !== main && (c === code ? on : others.includes(c))),
    })
  return (
    <Section
      id="as-languages"
      title={t('settings.assistant.languages.title')}
      help={{
        text: (
          <T
            k="settings.assistant.languages.help"
            values={{
              named: draft.name.trim() ? 'yes' : 'no',
              name: draft.name.trim(),
              link: appLink(sectionHash('workspace', 'general')),
            }}
          />
        ),
      }}
    >
      {/* Both selects right under their labels, so they line up; the note on "Any" goes under its select. */}
      <div className="as-languages-row">
        <Field id="as-languages-main" label={t('settings.assistant.languages.main')}>
          <Select
            id="as-languages-main"
            label={t('settings.assistant.languages.main')}
            value={main}
            options={languageOptions}
            onChange={onMainLanguage}
          />
          {country && (
            <FollowsLine
              source={{ kind: 'country', country }}
              follows={draft.main_language_follows}
              sourceDefault={languageLabel(countryLanguage ?? 'en', ui)}
              link={sectionHash('workspace', 'general')}
              controlId="as-languages-main"
              onReset={onCountryLanguage}
            />
          )}
        </Field>
        <Field id="as-languages-mode" label={t('settings.assistant.languages.also')}>
          <Select
            id="as-languages-mode"
            label={t('settings.assistant.languages.also')}
            value={mode}
            options={alsoModes(t, mainName)}
            onChange={m => set('languages', { ...draft.languages, mode: m })}
          />
          {anyLimited && <p className="k-field-desc as-languages-note">{t('settings.assistant.languages.anyNote')}</p>}
        </Field>
      </div>
      {mode !== 'english' && (
        <div
          className="as-languages"
          role="group"
          aria-label={t('settings.assistant.languages.others', { language: mainName })}
        >
          {offered
            .filter(code => code !== main)
            .map(code => (
              <Checkbox
                key={code}
                checked={mode === 'any' ? coveredByAny(code) : others.includes(code)}
                disabled={mode === 'any'}
                onChange={on => toggle(code, on)}
              >
                {languageLabel(code, ui)}
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
  const t = useT()
  const format = useFormat()
  const pct = draft.talking_speed_pct
  // "Normal", "8% slower", "15% faster".
  const by = format.number(Math.abs(pct - TALKING_SPEED_PCT_DEFAULT) / 100, { style: 'percent' })
  const label =
    pct === TALKING_SPEED_PCT_DEFAULT
      ? t('settings.assistant.speed.normal')
      : t(pct < TALKING_SPEED_PCT_DEFAULT ? 'settings.assistant.speed.slowerBy' : 'settings.assistant.speed.fasterBy', {
          percent: by,
        })
  return (
    <Section
      id="as-speed"
      title={t('settings.assistant.speed.title')}
      help={t('settings.assistant.speed.help')}
      // The value only once: at the default the "Normal" stop under the slider already says it.
      actions={pct !== TALKING_SPEED_PCT_DEFAULT && <span className="as-speed-value is-changed">{label}</span>}
    >
      <div className="as-speed">
        <input
          id="as-speed-range"
          type="range"
          min={TALKING_SPEED_PCT_MIN}
          max={TALKING_SPEED_PCT_MAX}
          step={1}
          value={pct}
          aria-label={t('settings.assistant.speed.title')}
          aria-valuetext={label}
          onChange={e => set('talking_speed_pct', Number(e.target.value))}
        />
        <div className="as-speed-stops">
          <span aria-hidden="true">{t('settings.assistant.speed.slower')}</span>
          <button
            type="button"
            className={pct === TALKING_SPEED_PCT_DEFAULT ? 'is-on' : undefined}
            disabled={pct === TALKING_SPEED_PCT_DEFAULT}
            title={t('settings.assistant.speed.back')}
            onClick={() => set('talking_speed_pct', TALKING_SPEED_PCT_DEFAULT)}
          >
            {t('settings.assistant.speed.normal')}
          </button>
          <span aria-hidden="true">{t('settings.assistant.speed.faster')}</span>
        </div>
      </div>
    </Section>
  )
}

function Advanced({ draft, set }: SectionProps) {
  const t = useT()
  const problem = silenceIssue(draft)
  const errorFor = (field: SilenceField) => (problem?.field === field ? problem.message : null)
  const name = assistantName(draft, t)
  return (
    <>
      <Section
        id="as-advanced"
        title={t('settings.assistant.silence.title')}
        help={t('settings.assistant.silence.help', { name })}
      >
        <div className="as-silence-row">
          <Field id="as-silence-gap" label={t('settings.assistant.silence.gap')} error={errorFor('gap')}>
            <TextInput
              id="as-silence-gap"
              value={draft.silence_first_gap_s}
              onChange={v => set('silence_first_gap_s', v)}
            />
          </Field>
          <Field id="as-silence-times" label={t('settings.assistant.silence.times')} error={errorFor('times')}>
            <TextInput
              id="as-silence-times"
              value={draft.silence_reminders}
              onChange={v => set('silence_reminders', v)}
            />
          </Field>
        </div>
        <Field id="as-silence-reminder" label={t('settings.assistant.silence.reminder')} error={errorFor('reminder')}>
          <TextInput
            id="as-silence-reminder"
            value={draft.silence_reminder}
            onChange={v => set('silence_reminder', v)}
            placeholder={DEFAULT_SILENCE_REMINDER}
          />
        </Field>
        <span className="help">{silenceSummary(draft)}</span>
      </Section>
      <Section
        id="as-hang-up"
        title={t('settings.assistant.hangUp.title')}
        help={t('settings.assistant.hangUp.help', { name })}
      >
        <Field id="as-goodbye-line" label={t('settings.assistant.hangUp.goodbye')} error={errorFor('goodbye')}>
          <TextInput id="as-goodbye-line" value={draft.goodbye_line} onChange={v => set('goodbye_line', v)} />
        </Field>
        <div className="as-silence-row">
          <Field id="as-silence-hang-up" label={t('settings.assistant.hangUp.afterSilence')} error={errorFor('hangUp')}>
            <TextInput
              id="as-silence-hang-up"
              value={draft.silence_hang_up_s}
              onChange={v => set('silence_hang_up_s', v)}
            />
          </Field>
          <Field id="as-max-call" label={t('settings.assistant.hangUp.longest')} error={errorFor('longest')}>
            <TextInput id="as-max-call" value={draft.max_call_minutes} onChange={v => set('max_call_minutes', v)} />
          </Field>
        </div>
        <Field id="as-silence-closing" label={t('settings.assistant.hangUp.closing')} error={errorFor('closing')}>
          <TextArea id="as-silence-closing" value={draft.silence_closing} onChange={v => set('silence_closing', v)} />
        </Field>
        <span className="help">{hangUpSummary(draft)}</span>
      </Section>
    </>
  )
}

/** `isInstanceAdmin`: the member runs the server (a test call nobody answers says what to fix there). */
/** `agentChange`: "Change with an AI agent" on top of General (owners and admins, AgentChange.tsx). */
/** `undoable`: a toast with Undo for a change the page undoes itself (removing a call email rule). */
type Props = {
  canEdit: boolean
  toast: (text: string) => void
  isInstanceAdmin?: boolean
  agentChange?: boolean
  undoable?: Undoable
}

type FormProps = Props & {
  assistant: Assistant
  assistants: Assistant[]
  numbers: PhoneNumber[]
  onPick: (id: string) => void
}

function Form({
  assistant,
  assistants,
  numbers,
  onPick,
  canEdit,
  toast,
  isInstanceAdmin = false,
  agentChange = false,
  undoable,
}: FormProps) {
  const t = useT()
  const format = useFormat()
  const run = useRun()
  const page = `assistant/${assistant.id}`
  const voiceOptions = useVoiceOptions().data
  const setUp = pipelinesOf(voiceOptions)
  const testCall = useTestCall(canEdit, assistant, isInstanceAdmin)
  /** A save was refused over a transfer contact: its errors show from then on. */
  const [transferSaveTried, setTransferSaveTried] = useState(false)
  const [emailSaveTried, setEmailSaveTried] = useState(false)
  const workspaceLanguage = useWorkspaceLanguage()
  const workspaceCountry = useWorkspaceCountry()
  const savedJson = JSON.stringify(draftOf(assistant, workspaceLanguage))
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
  // The page follows the level picked here at once, before it is saved: Ultra answers with the realtime model's voices.
  const realtime = draft.call_quality === 'ultra'
  const openReview = useQuery(canEdit ? reviewListKey(assistant.id, true) : null, loadReviewList(assistant.id, true))
  const openQuestions = useRows('knowledge_questions').filter(
    q => q.assistant_id === assistant.id && q.status === 'open',
  ).length
  const openItems = (openReview.data?.total ?? 0) + openQuestions
  const shown = useMemo(
    () => sectionsFor(sectionsIn(t), assistant.name, canEdit, openItems),
    [t, assistant.name, canEdit, openItems],
  )
  const current = useSection(page, shown)
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

  const outboundCountries = useOutboundCountries()

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
    const transfer = transferProblem(draft, outboundCountries)
    if (transfer) {
      setTransferSaveTried(true)
      return goTo('transfers', transferFieldId(transfer.index, transfer.field))
    }
    if (silenceProblem(draft)) return goTo('advanced', 'as-silence-gap')
    if (languagesProblem(draft)) return goTo('general', 'as-languages-mode')
    const noTopic = draft.email_rules.rules.findIndex(r => !r.when.trim())
    if (noTopic >= 0) {
      setEmailSaveTried(true)
      return goTo('emails', emailRuleWhenId(noTopic))
    }
    const problem = draftProblem(draft, outboundCountries)
    if (problem) return toast(problem)
    if (dirty) {
      const clean = normalized(draft)
      void run('assistant.update', {
        assistantId: assistant.id,
        name: clean.name,
        greeting: clean.greeting,
        ai_disclosure: clean.ai_disclosure,
        communication_style: clean.communication_style,
        business_profile: profileOf(clean),
        ...outsideToSave(clean),
        // Only when changed: putting calls through to a number waits for a confirmed email, other edits do not.
        ...(JSON.stringify(clean.transfers) !== JSON.stringify(normalized(saved).transfers)
          ? { transfers: transfersToSave(clean) }
          : {}),
        ...silenceToSave(clean),
        behaviours: behavioursToSave(clean),
        // Only when changed: the server checks the languages against the voice providers set up, and a main language
        // that follows the workspace language is not the assistant's own choice to check.
        ...(JSON.stringify(languagesToSave(clean)) !== JSON.stringify(languagesToSave(normalized(saved)))
          ? languagesToSave(clean)
          : {}),
        ...levelChoicesToSave(clean),
        // Only when changed: an API of the release before does not know it.
        ...(clean.realtime_voice !== normalized(saved).realtime_voice ? { realtime_voice: clean.realtime_voice } : {}),
        talking_speed_pct: clean.talking_speed_pct,
        // Only when changed: an API of the release before does not know it.
        ...(JSON.stringify(clean.email_rules) !== JSON.stringify(normalized(saved).email_rules)
          ? { email_rules: clean.email_rules }
          : {}),
      })
      setDraft(clean) // the form shows what was saved, so it is not "dirty" any more
    }
    toast(savedNote(normalized(draft)))
  }
  /** "Saved.", and on a new level what the calls cost now (or which level, where there are no prices). */
  const savedNote = (clean: Draft) =>
    levelSavedNote(assistantName(clean, t), clean.call_quality, saved.call_quality, voiceOptions?.callQuality) ??
    t('settings.assistant.saved')
  /**
   * A new main language: its default texts. The voice follows in VoiceSettings, which switches it when it can't
   * perform the assistant's languages (the same for a change of the other languages).
   */
  function changeMainLanguage(code: Language) {
    setDraft(d => withMainLanguage(d, code))
  }
  /** "Use country default": the workspace language again, and it follows the country from then on (once saved). */
  function followCountryLanguage() {
    setDraft(d => withMainLanguage(d, mainLanguageOf(null, workspaceLanguage), true))
  }

  function cancel() {
    setDraft(saved)
  }
  const elsewhere = [...unsaved].filter(id => id !== current)
  const elsewhereNames = format.list(
    elsewhere.map(id => shown.find(s => s.id === id)!.label),
    { type: 'unit', style: 'short' },
  )
  const note =
    elsewhere.length > 0
      ? t(unsaved.has(current) ? 'settings.assistant.unsavedInAndHere' : 'settings.assistant.unsavedIn', {
          sections: elsewhereNames,
        })
      : undefined

  // Hours and holidays have forms of their own; everything else is inside the draft's form.
  const body = (
    <>
      <fieldset className="st-fields" disabled={!canEdit}>
        {current === 'business' && (
          <Knowledge assistant={assistant} draft={draft} set={set} replace={setDraft} canEdit={canEdit} toast={toast} />
        )}
        {current === 'general' && (
          <>
            {agentChange && (
              <AgentChangeNote
                target={{ kind: 'assistant', assistantId: assistant.id }}
                assistantName={assistant.name}
              />
            )}
            <AssistantNameSection draft={draft} set={set} />
            <Greeting draft={draft} set={set} savedName={assistant.name} hoursOn={hoursOn} canEdit={canEdit} />
            <Languages
              draft={draft}
              set={set}
              onMainLanguage={changeMainLanguage}
              onCountryLanguage={canEdit ? followCountryLanguage : undefined}
              country={workspaceCountry ? phoneCountryName(workspaceCountry.country, i18n()) : null}
              countryLanguage={mainLanguageOf(null, workspaceLanguage)}
              installed={voiceOptions?.languages}
              anyCovers={voiceOptions?.anyLanguages ?? voiceOptions?.languages}
            />
            <NotAnswered setUp={setUp} />
            <CallQualitySettings
              picks={draft}
              onChange={picks => setDraft(d => ({ ...d, ...picks }))}
              name={assistantName(draft, t)}
              savedLevel={saved.call_quality}
            />
            {/* With nothing that answers, the note in Answering calls already names the missing voice: the Voice card
                would only say it again (one note per page). */}
            {!(nothingAnswers(setUp) && !realtime && voiceOptions && !voiceOptions.provider) && (
              <VoiceLoading>
                {realtime ? (
                  <RealtimeVoiceSettings
                    voice={draft.realtime_voice}
                    onPick={v => set('realtime_voice', v)}
                    canEdit={canEdit}
                    language={mainOf(draft)}
                    otherLanguages={otherLanguagesOf(draft.languages)}
                    assistantName={assistantName(draft, t)}
                  />
                ) : (
                  <VoiceSettings
                    assistantId={assistant.id}
                    voice={draft.voice}
                    onPick={v => set('voice', withPickedVoice(v, draft.voice))}
                    canEdit={canEdit}
                    toast={toast}
                    language={mainOf(draft)}
                    otherLanguages={otherLanguagesOf(draft.languages)}
                    assistantName={assistantName(draft, t)}
                  />
                )}
              </VoiceLoading>
            )}
          </>
        )}
        {current === 'rules' && (
          <>
            <RulesSummary name={assistantName(draft, t)} draft={draft} />
            <Behaviours draft={draft} set={set} />
          </>
        )}
        {current === 'transfers' && (
          <>
            <TransfersSummary name={assistantName(draft, t)} transfers={draft.transfers} hoursOn={hoursOn} />
            <TransferContacts
              transfers={draft.transfers}
              onChange={list => set('transfers', list)}
              hoursOn={hoursOn}
              assistantName={assistantName(draft, t)}
              showErrors={transferSaveTried}
            />
          </>
        )}
        {current === 'emails' && (
          <CallEmails
            name={assistantName(draft, t)}
            rules={draft.email_rules}
            onChange={update => setDraft(d => ({ ...d, email_rules: update(d.email_rules) }))}
            canEdit={canEdit}
            undoable={undoable}
            showErrors={emailSaveTried}
          />
        )}
        {current === 'advanced' && (
          <>
            <TalkingSpeedSection draft={draft} set={set} />
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
      title={t('settings.assistant.title')}
      context={
        <AssistantHeader
          assistant={assistant}
          assistants={assistants}
          numbers={numbers}
          canEdit={canEdit}
          onPick={onPick}
          toast={toast}
        />
      }
      actions={<TestCallButton session={testCall} />}
      banner={<TestCallPanel session={testCall} />}
      sections={shown}
      current={current}
      unsaved={unsaved}
    >
      {/* Members: why nothing here can change, once on top (Webhooks says it in its own words). */}
      {!canEdit && current !== 'review' && current !== 'webhooks' && <ReadOnlyNote />}
      {current === 'review' ? (
        <AssistantReview
          assistant={assistant}
          toast={toast}
          onAnswered={(question, answer) => {
            // The server added it to the saved text; the draft gets it too, so unsaved edits keep it.
            const line = answeredQuestionLine(question, answer)
            setDraft(d =>
              d.instructions.includes(line)
                ? d
                : { ...d, instructions: [d.instructions.trim(), line].filter(Boolean).join('\n') },
            )
          }}
        />
      ) : current === 'hours' ? (
        <>
          <HoursSummary
            assistantId={assistant.id}
            name={assistantName(draft, t)}
            outsideGreeting={!!draft.greeting_outside.trim()}
          />
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
  // Notifications are your own settings now (Account settings › Notifications), not the assistant's.
  if (section === 'notifications')
    return history.replaceState(null, '', `#account/notifications${query ? `?${query}` : ''}`)
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

/** How many cards each section shows, so its skeleton has the same number and nothing jumps when they arrive. */
const SECTION_CARDS: Record<SectionId, number> = {
  general: 4,
  review: 2,
  business: 1,
  hours: 3,
  rules: 1,
  transfers: 1,
  emails: 3,
  booking: 3,
  webhooks: 1,
  advanced: 3,
}

/** The section the hash names (`#assistant/<id>/<section>` or `#assistant/<section>`, old ids too), else the first. */
function sectionInHash(): SectionId {
  const [, ...parts] = window.location.hash.replace(/^#/, '').split('?')[0]!.split('/')
  for (const part of parts.slice(0, 2)) {
    const id = OLD_SECTIONS[part] ?? part
    if (SECTION_IDS.includes(id as SectionId)) return id as SectionId
  }
  return SECTION_IDS[0]!
}

/**
 * Before the assistants first arrive on this device: the page's frame, never "No assistant yet". The header has the
 * real one's shape (the name, the row of number chips, the test call button) and the section one card per real card.
 */
function AssistantSkeleton({ slow }: { slow: boolean }) {
  const t = useT()
  if (slow) return <LoadProblem what={t('settings.assistant.load')} slow />
  const current = sectionInHash()
  return (
    <SettingsLayout
      page="assistant"
      title={t('settings.assistant.title')}
      context={
        <div className="as-head">
          <div className="as-title">
            <span className="as-name">
              <Skeleton shape="text" width={64} />
            </span>
          </div>
          <div className="as-numbers">
            <Skeleton width={120} height={24} />
          </div>
        </div>
      }
      actions={<Skeleton width={136} height={32} />}
      sections={sectionsIn(t)}
      current={current}
    >
      <Loading
        what={t('settings.assistant.load')}
        loading
        skeleton={Array.from({ length: SECTION_CARDS[current] }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cards never reorder
          <SkeletonSection key={i} fields={1} />
        ))}
      />
    </SettingsLayout>
  )
}

export function AssistantSettings(props: Props) {
  const t = useT()
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
  // The skeleton stays until the gate lets it go (no flash, no blink), then the assistant's page takes its place.
  const held = useLoading(!assistant && loadState === 'loading').phase !== 'content'
  const onPick = useCallback((id: string) => {
    window.location.hash = `#assistant/${id}/${SECTION_IDS[0]!}`
  }, [])
  return (
    <div className="page">
      {assistant && !held ? (
        <Form
          key={assistant.id}
          assistant={assistant}
          assistants={assistants}
          numbers={numbers}
          onPick={onPick}
          {...props}
        />
      ) : loadState !== 'ready' || held ? (
        <AssistantSkeleton slow={loadState === 'slow'} />
      ) : (
        <div className="empty">
          <b>{t('settings.assistant.empty')}</b>
        </div>
      )}
    </div>
  )
}
