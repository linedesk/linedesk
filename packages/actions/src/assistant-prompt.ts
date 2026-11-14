// How every assistant handles a call: fixed rules in its instructions, not a setting.

import type { Language } from './languages.ts'
import { spokenLines } from './spoken-lines.ts'

/**
 * Facts and prices: only the ones the business gave, never a guess or an estimate; always part of the prompt, after
 * what the business wants the assistant to know.
 */
export const PRICE_RULE =
  "Only state facts and prices the business gave you above, exactly as written; never guess or estimate one. If you don't know something, say so; for a price, say the team will get back to them with one, and take a message."

/** What the call has: booking and transfer on or off; left out (the evaluation judges calls of any setup): both cases. */
export type CallSetup = { booking?: boolean; transfer?: boolean }

const ASK_TIMES = 'ask which day and time suit the caller, put that in the message and say the team will confirm.'

/**
 * How every assistant handles a call: fixed rules, not a setting, with only the cases of this call's setup. The
 * caller's name, callback number, prices and promises have their own parts of the prompt and are not repeated here.
 */
/**
 * The one fixed safety rule, the same for every business: an emergency goes to 911, not to the business. Everything
 * else that can't wait is an urgent matter, handled by the owner's urgent rules (transfer contacts, flag_urgent).
 */
export const EMERGENCY_RULE =
  'Emergencies (danger to people, fire, a break-in, a gas smell): tell the caller to hang up and call 911 right away, before anything else.'

export function callRules({ booking, transfer }: CallSetup = {}): string {
  // With booking the booking section says how; without it, the times go into the message.
  const appointments =
    booking === undefined
      ? `Appointments: if you can book, follow the booking steps. If not, ${ASK_TIMES}`
      : booking
        ? null
        : `Appointments: ${ASK_TIMES}`
  const canTransfer = transfer !== false
  return [
    EMERGENCY_RULE,
    // take_message's result tells the assistant to say the team will get back to the caller.
    'Take a message for every request you cannot handle yourself: a callback, a visit, a quote.',
    appointments,
    `If the caller asks for a specific person: ${canTransfer ? 'put them through if a transfer contact covers it, otherwise ' : ''}take a message for that person and say they will call back.`,
    'If the call is a sales pitch or spam, stay polite, keep it short and say goodbye.',
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
    say: "Ask for the caller's name when you do not know it yet.",
    sayOff:
      "Do not ask for the caller's name unless you need it to book an appointment; a message without a name is fine.",
  },
  {
    id: 'offer_callback',
    label: "Offer a callback when you can't answer",
    on: true,
    say: 'When you cannot answer a question or help with a request, offer that someone from the team calls the caller back, and take a message.',
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
export const REMOVED_BEHAVIOUR_IDS = ['emergency_fee', 'ask_referral', 'listed_prices_only'] as const

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
 * The greeting as said on the call: with the AI note when the mode says so at the start, and in the consent
 * mode ending with the consent question instead of its own closing question ("How can I help?").
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

/** Said in every mode: asked, the assistant always says it is an AI and never claims to be human. */
const AI_WHEN_ASKED =
  'Whenever the caller asks whether you are a person, a robot or an AI, say truthfully that you are an AI assistant. Never claim to be human.'

/** The prompt's part about being an AI: when to mention it (the setting), and the honesty rule every mode keeps. */
export function aiDisclosureInstructions(mode: AiDisclosure | null | undefined): string {
  switch (mode ?? DEFAULT_AI_DISCLOSURE) {
    case 'never':
      return `Do not bring up on your own that you are an AI. ${AI_WHEN_ASKED}`
    case 'when_asked':
      return AI_WHEN_ASKED
    case 'at_start':
      // The greeting said it; the model has the greeting as its first message (LIN-130).
      return AI_WHEN_ASKED
    case 'at_start_consent':
      // The greeting asked AI_CONSENT_QUESTION; the model has it as its first message (LIN-130).
      return `If the caller does not want to talk to an AI, don't persuade them: put them through if a transfer contact fits, else take a message with their name and reason so a person calls back. ${AI_WHEN_ASKED}`
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
  casual:
    'Tone: casual and relaxed. Talk like a friendly local business, in everyday words, still clear and to the point.',
  formal: 'Tone: formal and factual. Courteous and precise, no small talk and no jokes.',
  empathetic:
    'Tone: empathetic and warm. Acknowledge how the caller feels, especially when something went wrong, and reassure them before you move on.',
}

/** The tone line for the instructions; null for the standard tone (or an API of an older version). */
export const communicationStyleInstructions = (style: CommunicationStyle | null | undefined): string | null =>
  STYLE_LINES[style ?? DEFAULT_COMMUNICATION_STYLE] ?? null
