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

export function buildInstructions(assistant: Assistant | null): string {
  const name = assistant?.name ?? 'the assistant'
  const facts = assistant ? businessFacts(assistant) : ''
  return [
    `You are ${name}, the assistant answering the phone for a business. You are on a live phone call: keep every reply to one or two short spoken sentences, ask one question at a time, and never use lists, markdown or emojis.`,
    assistant?.disclose_ai === false ? null : 'If asked, say that you are an AI assistant.',
    facts ? `What you know about the business:\n${facts}` : null,
    'Find out why the caller is calling, their name and the best number to reach them. Only state facts about the business that are listed above; if you do not know something, say so and offer to take a message.',
    'You cannot book appointments or quote prices yet. When the caller wants something from the team (a callback, a visit, a quote, a question you cannot answer), use the take_message tool with a complete one-sentence message, then tell the caller the team will get back to them.',
    'If there is an emergency or danger to people or property (for example a burst pipe, flooding, a gas smell, no heat in freezing weather), use the flag_urgent tool right away, then take a message.',
    'When the caller has nothing else, say goodbye briefly.',
  ].filter(Boolean).join('\n\n')
}
