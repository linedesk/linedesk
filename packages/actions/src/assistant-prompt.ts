// How every assistant handles a call: fixed rules in its instructions, not a setting.

import type { Language } from './languages.ts'
import {
  ASK_TIMES_TEXT,
  defaultPromptTexts,
  PROMPT_TEXTS,
  type PromptTextKey,
  type PromptTexts,
} from './prompt-texts.ts'
import { defaultGreetingWithAi, spokenLines } from './spoken-lines.ts'

/**
 * Facts and prices: only the ones the business gave, never a guess or an estimate; always part of the prompt, after
 * what the business wants the assistant to know.
 */
export const PRICE_RULE = PROMPT_TEXTS['knowledge.price'].text

/** What the call has: booking and transfer on or off; left out (the evaluation judges calls of any setup): both cases. */
export type CallSetup = { booking?: boolean; transfer?: boolean }

/**
 * How every assistant handles a call: fixed rules, not a setting, with only the cases of this call's setup. The
 * caller's name, callback number, prices and promises have their own parts of the prompt and are not repeated here.
 */
/**
 * The one fixed safety rule, the same for every business and country. It starts with the urgent case: a problem that
 * can't wait (a burst pipe) is for the team, handled by the owner's urgent rules (transfer contacts, flag_urgent); before
 * it said so, gpt-4.1-mini sent such callers to the emergency services when no one could be put through (LIN-353). Only
 * when a person may be in danger right now, the caller hears to contact the emergency services, and the assistant keeps
 * helping if they stay on the call. It names no number.
 */
export const EMERGENCY_RULE = PROMPT_TEXTS['rules.emergency'].text

/** `pt`: the parts' texts (the instance admin's overrides at call time). */
export function callRules({ booking, transfer }: CallSetup = {}, pt: PromptTexts = defaultPromptTexts): string {
  // With booking the booking section says how; without it, the times go into the message.
  const appointments =
    booking === undefined
      ? `Appointments: if you can book, follow the booking steps. If not, ${ASK_TIMES_TEXT}`
      : booking
        ? null
        : pt('rules.appointments')
  const canTransfer = transfer !== false
  return [
    pt('rules.emergency'),
    // No tool saves the message: the summary after the call writes it from the whole call.
    pt('rules.message'),
    appointments,
    pt(canTransfer ? 'rules.person' : 'rules.personNoTransfer'),
    pt('rules.spam'),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The behaviour checklist (Settings, Assistant, Calls): plain-language switches that add a line to the
 * assistant's instructions. An assistant stores only the switches the owner changed (`assistants.behaviours`);
 * the others use `on` here, so a better default reaches it. `say` is the line when on, `sayOff` when off.
 */
export const BEHAVIOURS = [
  {
    id: 'ask_name',
    label: "Ask for the caller's name if unknown",
    on: true,
    say: 'owner.askName',
    sayOff: 'owner.askNameOff',
  },
  {
    id: 'offer_callback',
    label: "Offer a callback when you can't answer",
    on: true,
    // On: the call rules already take a message for whatever the assistant can't handle; no line of its own.
    say: null,
    sayOff: 'owner.offerCallbackOff',
  },
  {
    id: 'confirm_number',
    label: 'Confirm the callback number',
    on: false,
    say: 'owner.confirmNumber',
  },
  {
    // Not a line: whether the prompt holds the caller's earlier calls, open next steps and upcoming appointments.
    id: 'caller_history',
    label: "Know the caller's previous calls",
    on: true,
    say: null,
  },
  {
    // Not a line: with it on, the prompt keeps the contact's and the booked name back when the caller can cancel or
    // move an appointment (the server checks a change by day and booked name; caller ID can be faked). Off by default:
    // Tim accepts that risk (2026-11-15).
    id: 'ask_booking_name',
    label: 'Ask for the booking name before changing an appointment',
    on: false,
    say: null,
  },
  {
    // Not a line: with it on, a phone caller is matched to their contact (name, notes, history, bookings, the
    // business's own caller lookup) only when the caller's carrier vouched for the number (STIR/SHAKEN attestation
    // A); any other call is handled like one from an unknown number. Caller ID is easy to fake. On by default (Tim, 2026-11-15).
    id: 'verified_caller_only',
    label: 'Recognize callers only when their carrier verified the number',
    on: true,
    say: null,
  },
] as const satisfies readonly {
  id: string
  label: string
  on: boolean
  say: PromptTextKey | null
  sayOff?: PromptTextKey
}[]

export type BehaviourId = (typeof BEHAVIOURS)[number]['id']
export const BEHAVIOUR_IDS = BEHAVIOURS.map(b => b.id) as [BehaviourId, ...BehaviourId[]]
/** Switches that were removed; still accepted from an older web app and dropped, and ignored when stored. */
export const REMOVED_BEHAVIOUR_IDS = ['emergency_fee', 'ask_referral', 'listed_prices_only'] as const

/** Whether a behaviour is on for an assistant: its own choice, else the default. */
export const behaviourOn = (stored: Readonly<Record<string, boolean>> | null | undefined, id: BehaviourId): boolean =>
  stored?.[id] ?? BEHAVIOURS.find(b => b.id === id)!.on

/** The lines the checklist adds to the instructions, in list order; empty when none applies. */
export function behaviourLines(
  stored: Readonly<Record<string, boolean>> | null | undefined,
  pt: PromptTexts = defaultPromptTexts,
): string[] {
  return BEHAVIOURS.flatMap(b => {
    const key = behaviourOn(stored, b.id) ? b.say : 'sayOff' in b ? b.sayOff : null
    return key ? [pt(key)] : []
  })
}

/**
 * Whether and when the assistant mentions it is an AI (`assistants.ai_disclosure`). Whatever the mode, it
 * never claims to be human and answers truthfully when asked (part of every mode's line in the prompt).
 */
export const AI_DISCLOSURE_MODES = ['never', 'when_asked', 'at_start', 'at_start_consent'] as const
export type AiDisclosure = (typeof AI_DISCLOSURE_MODES)[number]
export const DEFAULT_AI_DISCLOSURE: AiDisclosure = 'when_asked'
export const AI_DISCLOSURE_LABELS: Record<AiDisclosure, string> = {
  never: "Don't mention",
  when_asked: 'Only when asked',
  at_start: 'At the start of the call',
  at_start_consent: 'At the start, caller must agree',
}
/** The modes whose greeting says it is an AI. */
export const disclosesAtStart = (mode: AiDisclosure) => mode === 'at_start' || mode === 'at_start_consent'

const DISCLOSURE = /,?\s*(?:the|an|your|a)\s+(?:virtual|AI)\s+assistant\b/i
export const disclosesAi = (greeting: string) => DISCLOSURE.test(greeting)

/** The greeting with "…, the AI assistant" after the assistant's name, or a sentence that says it. */
export function withDisclosure(greeting: string, name: string, language: Language = 'en'): string {
  if (language !== 'en') return withLocalDisclosure(greeting, name, language)
  if (disclosesAi(greeting)) return greeting
  const who = name.trim() || 'the assistant'
  const named = new RegExp(`(\\bthis is ${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i')
  if (named.test(greeting)) return greeting.replace(named, '$1, the AI assistant')
  const sentence = `This is ${who}, the AI assistant.`
  const firstEnd = greeting.search(/[.!?]\s/)
  if (firstEnd < 0) return greeting.trim() ? `${greeting.trim()} ${sentence}` : sentence
  return `${greeting.slice(0, firstEnd + 1)} ${sentence}${greeting.slice(firstEnd + 1)}`
}

/** The greeting without the AI disclosure. */
export function withoutDisclosure(greeting: string, name = '', language: Language = 'en'): string {
  if (language === 'en') return greeting.replace(DISCLOSURE, '')
  const lines = spokenLines(language)
  const sentence = lines.aiSentence(name.trim())
  const without = greeting.includes(sentence)
    ? greeting.replace(sentence, '')
    : greeting.replace(aiAppositive(language), '')
  return without.replace(/\s{2,}/g, ' ').trim()
}

/** The words the default greeting of a language adds for the AI note (", asistente de IA"). */
function aiAppositive(language: Language): string {
  const lines = spokenLines(language)
  const noted = lines.greeting('B', 'N', true)
  const plain = lines.greeting('B', 'N', false)
  let start = 0
  while (start < plain.length && noted[start] === plain[start]) start++
  return noted.slice(start, start + noted.length - plain.length)
}

/** What the caller is asked in the consent mode, in place of the greeting's closing question. */
export const AI_CONSENT_QUESTION = 'Is that okay with you?'

/**
 * The greeting with the AI note when the mode says so at the start, and in the consent mode ending with the
 * consent question instead of its own closing question ("How can I help?"). The settings write it into the
 * greeting field when the owner picks the mode; the call says the saved greeting as written.
 */
export function greetingWithDisclosure(
  greeting: string,
  name: string,
  mode: AiDisclosure,
  language: Language = 'en',
): string {
  if (!greeting.trim() || !disclosesAtStart(mode)) return greeting
  const noted = withDisclosure(greeting.trim(), name, language)
  if (mode === 'at_start') return noted
  const sentences = noted.match(SENTENCE)?.map(s => s.trim()) ?? [noted]
  const kept = /[?？]$/.test(sentences.at(-1) ?? '') && sentences.length > 1 ? sentences.slice(0, -1) : sentences
  return `${kept.join(' ')} ${spokenLines(language).consentQuestion}`
}

/**
 * The greeting without the consent question at its end: the default greeting's closing question ("How can I help?")
 * takes its place again. Used when the owner leaves the consent mode.
 */
export function withoutConsentQuestion(greeting: string, language: Language = 'en'): string {
  const lines = spokenLines(language)
  const trimmed = greeting.trim()
  if (!trimmed.endsWith(lines.consentQuestion)) return greeting
  const closing = lines.greeting('B', 'N', false).match(SENTENCE)?.at(-1)?.trim() ?? ''
  return `${trimmed.slice(0, -lines.consentQuestion.length).trim()} ${closing}`.trim()
}

/**
 * The greeting with a sentence (the recording notice) said right after it: before its closing question when it ends
 * with one ("How can I help?"), so the caller hears the notice without a pause and answers the question last.
 */
export function withSentenceBeforeQuestion(greeting: string, sentence: string): string {
  const sentences = greeting
    .trim()
    .match(SENTENCE)
    ?.map(s => s.trim()) ?? [greeting.trim()]
  const question = sentences.length > 1 && /[?？]$/.test(sentences.at(-1) ?? '') ? sentences.pop() : undefined
  return [...sentences, sentence, ...(question ? [question] : [])].join(' ')
}

/** Sentences, also with the full stops and question marks of Hindi and Japanese. */
const SENTENCE = /[^.!?。！？।]+[.!?。！？।]+|[^.!?。！？।]+$/g

/** A greeting in a language other than English with that language's AI sentence after its first sentence, unless it says it already. */
function withLocalDisclosure(greeting: string, name: string, language: Language): string {
  const lines = spokenLines(language)
  if (lines.aiNote.test(greeting)) return greeting
  const defaultGreeting = defaultGreetingWithAi(greeting, language)
  if (defaultGreeting) return defaultGreeting
  const sentence = lines.aiSentence(name.trim() || name)
  const firstEnd = greeting.search(/[.!?。！？।]/)
  if (firstEnd < 0 || firstEnd === greeting.length - 1) return `${greeting} ${sentence}`
  return `${greeting.slice(0, firstEnd + 1)} ${sentence} ${greeting.slice(firstEnd + 1).trim()}`
}

/**
 * The prompt's part about being an AI: when to mention it (the setting), and the honesty rule every mode keeps
 * (ai.whenAsked: asked, the assistant always says it is an AI and never claims to be human).
 */
export function aiDisclosureInstructions(
  mode: AiDisclosure | null | undefined,
  pt: PromptTexts = defaultPromptTexts,
): string {
  switch (mode ?? DEFAULT_AI_DISCLOSURE) {
    case 'never':
      return `${pt('ai.never')} ${pt('ai.whenAsked')}`
    case 'when_asked':
      return pt('ai.whenAsked')
    case 'at_start':
      // The greeting is the owner's own text, said as written: the model says it next if the greeting did not.
      return `${pt('ai.atStart')} ${pt('ai.whenAsked')}`
    case 'at_start_consent':
      return `${pt('ai.atStartConsent')} ${pt('ai.consent')} ${pt('ai.whenAsked')}`
  }
}

/** The tone the assistant uses (`assistants.communication_style`); each but `standard` adds one line to the instructions. */
export const COMMUNICATION_STYLES = ['standard', 'professional', 'casual', 'formal', 'empathetic'] as const
export type CommunicationStyle = (typeof COMMUNICATION_STYLES)[number]
export const DEFAULT_COMMUNICATION_STYLE: CommunicationStyle = 'standard'
export const COMMUNICATION_STYLE_LABELS: Record<CommunicationStyle, string> = {
  standard: 'Standard',
  professional: 'Professional and friendly',
  casual: 'Casual and relaxed',
  formal: 'Formal and factual',
  empathetic: 'Empathetic and warm',
}
const STYLE_LINES: Record<CommunicationStyle, PromptTextKey | null> = {
  standard: null,
  professional: 'tone.professional',
  casual: 'tone.casual',
  formal: 'tone.formal',
  empathetic: 'tone.empathetic',
}

/** The tone line for the instructions; null for the standard tone (or an API of an older version). */
export function communicationStyleInstructions(
  style: CommunicationStyle | null | undefined,
  pt: PromptTexts = defaultPromptTexts,
): string | null {
  const key = STYLE_LINES[style ?? DEFAULT_COMMUNICATION_STYLE]
  return key ? pt(key) : null
}
