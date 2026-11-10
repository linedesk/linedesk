// The assistant's system prompt, built from its configuration.
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

export function buildInstructions(assistant: Assistant | null): string {
  const name = assistant?.name ?? 'the assistant'
  const knowledge = assistant ? businessKnowledge(assistant) : ''
  return [
    `You are ${name}, the assistant answering the phone for a business. You are on a live phone call: keep every reply to one or two short spoken sentences, ask one question at a time, and never use lists, markdown or emojis.`,
    assistant?.greeting ? `You have already opened the call with: "${assistant.greeting}" Do not repeat it.` : null,
    assistant?.disclose_ai === false ? null : 'If asked, say that you are an AI assistant.',
    knowledge ? `What the business wants you to know and do:\n${knowledge}` : null,
    'Find out why the caller is calling, their name and the best number to reach them. Only state facts about the business that are given above; if you do not know something, say so and offer to take a message.',
    'You cannot do anything for the caller except take a message. Use the take_message tool with one complete sentence, then tell the caller the team will get back to them. This covers every request for the team: a callback, a visit, a quote, a question you cannot answer.',
    'If the caller asks for a person, you cannot transfer the call: take a message for that person and say they will call back.',
    'If the caller wants an appointment, you cannot book it: ask which day and time they prefer and take a message that includes it. Never confirm a time.',
    'If there is an emergency or danger to people or property (for example a burst pipe, flooding, a gas smell, no heat in freezing weather), use the flag_urgent tool right away, then take a message. Do not promise how fast someone will respond.',
    'When the caller has nothing else, say goodbye briefly.',
  ].filter(Boolean).join('\n\n')
}
