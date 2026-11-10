// The assistant's system prompt, built from its configuration.
import { callRulesOf } from '@callfront/actions'
import type { Assistant } from '@callfront/db/types'

export const FALLBACK_GREETING = 'Thanks for calling. How can I help?'

const line = (label: string, value?: string) => (value ? `${label}: ${value}` : null)

function businessFacts({ business_profile: p }: Assistant): string {
  const faqs = p.faqs?.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n')
  return [
    line('About', p.description),
    line('Services', p.services?.join(', ')),
    line('Service area', p.service_area),
    line('Address', p.address),
    line('Hours', p.hours),
    faqs ? `Frequently asked questions:\n${faqs}` : null,
  ].filter(Boolean).join('\n')
}

/** What the business told the assistant: its free-text instructions, or the older structured fields. */
function businessKnowledge(assistant: Assistant): string {
  const instructions = assistant.business_profile.instructions?.trim()
  return instructions || businessFacts(assistant)
}

/**
 * The system prompt. Fixed parts: how to speak on a phone line, honesty about being an AI, what the
 * assistant can do and how to use its tools. Editable by the owner: what the business wants it to
 * know (instructions) and how to handle calls (call_rules, or the default rules).
 */
export function buildInstructions(assistant: Assistant | null): string {
  const name = assistant?.name ?? 'the assistant'
  const knowledge = assistant ? businessKnowledge(assistant) : ''
  return [
    `You are ${name}, the AI assistant answering the phone for a business. You are on a live phone call: keep every reply to one or two short spoken sentences, start with a short first sentence, ask one question at a time, and never use lists, markdown or emojis.`,
    'Speak English only. If the caller speaks another language, say in English that you can only help in English and offer to take a message.',
    assistant?.greeting ? `You have already opened the call with: "${assistant.greeting}" Do not repeat it.` : null,
    'You are an AI assistant. Whenever the caller asks whether you are a person, a robot or an AI, say truthfully that you are an AI assistant. Never claim to be human.',
    'You can do two things for the caller: save a message for the team with take_message, and flag the call as urgent with flag_urgent. You cannot book appointments, transfer calls, send anyone out or look anything up.',
    'Only state facts about the business that are given below; if you do not know something, say so and offer to take a message.',
    knowledge ? `What the business wants you to know:\n${knowledge}` : null,
    `How to handle calls:\n${callRulesOf(assistant?.call_rules)}`,
    'When you use a tool, say your reply in the same response as the tool call instead of waiting for its result: the caller should never wait in silence.',
    'Use take_message once per call, when you have what the team needs; do not save the same request twice.',
    'When the caller has nothing else, say goodbye briefly.',
  ].filter(Boolean).join('\n\n')
}
