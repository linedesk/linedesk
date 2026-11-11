// The default "How to handle calls" rules of an assistant. The owner can rewrite them in Settings,
// Assistant; an assistant that has none stored (null) uses these, so a better default reaches it.

import type { Language } from './languages.ts'
import { spokenLines } from './spoken-lines.ts'

/** Longest call-handling rules an assistant takes (characters). */
export const CALL_RULES_MAX = 10_000

export const DEFAULT_CALL_RULES = `Find out why the person is calling. Ask one thing at a time.
Name: ask for it only if you do not know who is calling. A saved contact does not need to give it again.
Callback number: you already have the caller's number. Ask for another one only if the caller wants to be called back on a different number, or if their number is withheld.
Take a message for every request you cannot handle yourself: a callback, a visit, a quote, a question you cannot answer. Then tell the caller the team will get back to them.
Appointments: if you can book, follow the booking steps. If not, ask which day and time suit the caller, put that in the message and say the team will confirm. Never confirm a time you did not book.
Prices: only give prices the business gave you. Otherwise do not guess: take a message so the team can call back with a price.
Emergencies or danger to people or property (a burst pipe, flooding, a gas smell, no heat in freezing weather): flag the call as urgent right away. If a transfer rule fits, put the caller through; otherwise take a message. Do not promise how fast someone will come.
If the caller asks for a specific person: put them through if a transfer rule covers it, otherwise take a message for that person and say they will call back.
If the call is a sales pitch or spam, stay polite, keep it short and say goodbye.`

/**
 * Earlier defaults. An assistant that stored one of them word for word never edited its rules, so it gets the
 * current default; edited rules are never replaced.
 */
const LEGACY_DEFAULT_CALL_RULES = [
  `Find out why the person is calling, their name and the best number to reach them. Ask one thing at a time.
Take a message for every request: a callback, a visit, a quote, a question you cannot answer. Then tell the caller the team will get back to them.
Appointments: you cannot book them. Ask which day and time suit the caller, put that in the message and say the team will confirm. Never confirm a time yourself.
Prices: do not quote prices or estimates. Say the team will give them a price, and take a message.
Emergencies or danger to people or property (a burst pipe, flooding, a gas smell, no heat in freezing weather): flag the call as urgent right away, then take a message. Do not promise how fast someone will come.
If the caller asks for a specific person, take a message for them and say they will call back.
If the call is a sales pitch or spam, stay polite, keep it short and say goodbye.`,
]

/** Whether stored rules are the default: none, or a default text (current or earlier) unchanged. */
export const usesDefaultCallRules = (stored: string | null | undefined): boolean => {
  const rules = stored?.trim()
  return !rules || rules === DEFAULT_CALL_RULES || LEGACY_DEFAULT_CALL_RULES.includes(rules)
}

/** The rules in effect: the stored ones, or the default when none or an unchanged earlier default are stored. */
export const callRulesOf = (stored: string | null | undefined): string =>
  usesDefaultCallRules(stored) ? DEFAULT_CALL_RULES : stored!.trim()

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
    say: "Ask for the caller's name when you do not know it yet.",
    sayOff: "Do not ask for the caller's name unless you need it to book an appointment; a message without a name is fine.",
  },
  {
    id: 'offer_callback',
    label: "Offer a callback when you can't answer",
    on: true,
    say: 'When you cannot answer a question or help with a request, offer that someone from the team calls the caller back, and take a message.',
  },
  {
    id: 'listed_prices_only',
    label: 'Never quote prices that are not in your list',
    on: true,
    say: null,
    sayOff:
      'Prices: for anything that is not in the services and prices list you may give a rough idea based on the listed prices, saying it is only an estimate and the team will confirm it.',
  },
  {
    id: 'confirm_number',
    label: 'Confirm the callback number',
    on: false,
    say: 'Before you save a message, read the number the team will call back on to the caller and ask them to confirm it.',
  },
] as const satisfies readonly { id: string; label: string; on: boolean; say: string | null; sayOff?: string }[]

export type BehaviourId = (typeof BEHAVIOURS)[number]['id']
export const BEHAVIOUR_IDS = BEHAVIOURS.map(b => b.id) as [BehaviourId, ...BehaviourId[]]
/** Switches that were removed; still accepted from an older web app and dropped, and ignored when stored. */
export const REMOVED_BEHAVIOUR_IDS = ['emergency_fee', 'ask_referral'] as const

/** Whether a behaviour is on for an assistant: its own choice, else the default. */
export const behaviourOn = (stored: Readonly<Record<string, boolean>> | null | undefined, id: BehaviourId): boolean =>
  stored?.[id] ?? BEHAVIOURS.find(b => b.id === id)!.on

/** The lines the checklist adds to the instructions, in list order; empty when none applies. */
export function behaviourLines(stored: Readonly<Record<string, boolean>> | null | undefined): string[] {
  return BEHAVIOURS.flatMap(b => {
    const line = behaviourOn(stored, b.id) ? b.say : 'sayOff' in b ? b.sayOff : null
    return line ? [line] : []
  })
}

/**
 * Whether and when the assistant mentions it is an AI (`assistants.ai_disclosure`). Whatever the mode, it
 * never claims to be human and answers truthfully when asked (a fixed rule of the prompt).
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
  const without = greeting.includes(sentence) ? greeting.replace(sentence, '') : greeting.replace(aiAppositive(language), '')
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
 * The greeting as said on the call: with the AI note when the mode says so at the start, and in the consent
 * mode ending with the consent question instead of its own closing question ("How can I help?").
 */
export function greetingWithDisclosure(greeting: string, name: string, mode: AiDisclosure, language: Language = 'en'): string {
  if (!greeting.trim() || !disclosesAtStart(mode)) return greeting
  const noted = withDisclosure(greeting.trim(), name, language)
  if (mode === 'at_start') return noted
  const sentences = noted.match(SENTENCE)?.map(s => s.trim()) ?? [noted]
  const kept = /[?？]$/.test(sentences.at(-1) ?? '') && sentences.length > 1 ? sentences.slice(0, -1) : sentences
  return `${kept.join(' ')} ${spokenLines(language).consentQuestion}`
}

/** Sentences, also with the full stops and question marks of Hindi and Japanese. */
const SENTENCE = /[^.!?。！？।]+[.!?。！？।]+|[^.!?。！？।]+$/g

/** A greeting in a language other than English with that language's AI sentence after its first sentence, unless it says it already. */
function withLocalDisclosure(greeting: string, name: string, language: Language): string {
  const lines = spokenLines(language)
  if (lines.aiNote.test(greeting)) return greeting
  const sentence = lines.aiSentence(name.trim() || name)
  const firstEnd = greeting.search(/[.!?。！？।]/)
  if (firstEnd < 0 || firstEnd === greeting.length - 1) return `${greeting} ${sentence}`
  return `${greeting.slice(0, firstEnd + 1)} ${sentence} ${greeting.slice(firstEnd + 1).trim()}`
}

/** The prompt's part about mentioning being an AI, on top of the fixed honesty rule; null when there is nothing to add. */
export function aiDisclosureInstructions(mode: AiDisclosure | null | undefined): string | null {
  switch (mode ?? DEFAULT_AI_DISCLOSURE) {
    case 'never':
      return 'Do not bring up on your own that you are an AI. Only if the caller asks directly, answer truthfully.'
    case 'when_asked':
      return 'You do not need to say you are an AI unless the caller asks; when they ask, say it plainly.'
    case 'at_start':
      return null
    case 'at_start_consent':
      return `Your greeting told the caller you are an AI assistant and asked "${AI_CONSENT_QUESTION}". If they agree, ask how you can help and go on as usual. If they do not want to talk to an AI, do not try to persuade them: if a transfer contact fits (for example one for callers who ask for a person), put them through; otherwise offer to take a message so a person from the team calls them back, and take it with their name and what it is about.`
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
const STYLE_LINES: Record<CommunicationStyle, string | null> = {
  standard: null,
  professional: 'Tone: professional and friendly. Polite and clear, warm without being chatty.',
  casual: 'Tone: casual and relaxed. Talk like a friendly local business, in everyday words, still clear and to the point.',
  formal: 'Tone: formal and factual. Courteous and precise, no small talk and no jokes.',
  empathetic: 'Tone: empathetic and warm. Acknowledge how the caller feels, especially when something went wrong, and reassure them before you move on.',
}

/** The tone line for the instructions; null for the standard tone (or an API of an older version). */
export const communicationStyleInstructions = (style: CommunicationStyle | null | undefined): string | null =>
  STYLE_LINES[style ?? DEFAULT_COMMUNICATION_STYLE] ?? null
