// Knowledge (docs/architecture.md, Knowledge): what an assistant knows about the business. The
// summary ("About the business", the assistant's instructions), services with prices and FAQs live in
// `assistants.business_profile` and are saved with assistant.update; documents, the website import and
// the questions callers asked that the assistant could not answer have their own actions.
import type { BusinessProfile } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

export const SERVICES_MAX = 50
export const FAQS_MAX = 30
export const SERVICE_NAME_MAX = 80
export const SERVICE_DESCRIPTION_MAX = 300
export const PRICE_MAX = 40
export const FAQ_QUESTION_MAX = 300
export const FAQ_ANSWER_MAX = 1000
/** Documents per assistant, and the largest file one may be. */
export const DOCUMENTS_MAX = 10
export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024
/** The largest request body knowledge.addDocument accepts: the file in base64 and a little JSON around it. */
export const DOCUMENT_BODY_MAX_BYTES = Math.ceil((DOCUMENT_MAX_BYTES * 4) / 3) + 64 * 1024
/** Text kept per document (characters); the rest of a very long one is left out. */
export const DOCUMENT_TEXT_MAX = 200_000
/** Documents of an assistant up to this many characters in all go into every call; above it the assistant looks them up. */
export const DOCUMENTS_INLINE_MAX = 6_000
export const documentTypes = ['application/pdf', 'text/plain', 'text/markdown'] as const

export type Service = { name: string; description: string; price: string }
export type Faq = { q: string; a: string }

export const serviceSchema = z.object({
  name: z.string().trim().min(1, 'Name the service.').max(SERVICE_NAME_MAX),
  description: z.string().trim().max(SERVICE_DESCRIPTION_MAX).default(''),
  /** Empty: quote only (the assistant gives no price). */
  price: z.string().trim().max(PRICE_MAX).default(''),
})
export const faqSchema = z.object({
  q: z.string().trim().min(1).max(FAQ_QUESTION_MAX),
  a: z.string().trim().min(1).max(FAQ_ANSWER_MAX),
})

/** The services, with legacy plain names (`services`) as quote-only entries when there is no list yet. */
export function servicesOf(p: BusinessProfile): Service[] {
  if (p.service_list) return p.service_list
  return (p.services ?? []).filter(s => s.trim()).map(name => ({ name: name.trim(), description: '', price: '' }))
}

/**
 * Untrusted text (a website, a document, the owner's lists) put between our tags: any opening or closing
 * tag with those names, with or without attributes or spaces (`</documents x>`, `< /page>`), is defused so
 * the text cannot end the fence early.
 */
export function fenceData(text: string, tags: readonly string[]): string {
  const names = tags.map(t => t.replace(/[^a-z_]/gi, '')).join('|')
  return text.replace(new RegExp(`<\\s*\\/?\\s*(${names})\\b[^>]*>?`, 'gi'), m =>
    m.replace(/</g, '‹').replace(/>/g, '›'),
  )
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** One service as the assistant reads it: "Drain cleaning: from $149 (clogged sinks and tubs)". */
export function serviceLine(s: Service): string {
  const price = s.price.trim() ? s.price.trim() : 'quote only, no price on the phone'
  const description = s.description.trim() ? ` (${oneLine(s.description)})` : ''
  return `- ${oneLine(s.name)}: ${oneLine(price)}${description}`
}

/** Services and FAQs as text for the assistant (and the call evaluation); empty when there are none. */
export function knowledgeLists(p: BusinessProfile): string {
  const services = servicesOf(p)
  const faqs = (p.faqs ?? []).filter(f => f.q.trim() && f.a.trim())
  return [
    services.length ? `Services and prices:\n${services.map(serviceLine).join('\n')}` : null,
    faqs.length
      ? `Frequently asked questions:\n${faqs.map(f => `Q: ${oneLine(f.q)}\nA: ${oneLine(f.a)}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// --- Website import ------------------------------------------------------------------------

/** What the assistant should do on calls, as the "Write with help" wizard offers them. */
export const assistantGoals = ['messages', 'booking', 'emergencies', 'prices', 'spam'] as const
export type AssistantGoal = (typeof assistantGoals)[number]
export const USE_CASES_MAX = 8
export const USE_CASE_MAX = 240
/** The owner's own words about the business in the wizard. */
export const BUSINESS_TEXT_MAX = 2_000

/** What the wizard proposes; nothing is saved until the owner picks parts, applies them and saves. */
export type KnowledgeImportData = {
  about: string
  /** Short "When a caller …, …" lines for how to handle common calls. */
  useCases: string[]
  services: Service[]
  faqs: Faq[]
  /** The pages that were read, for the review. */
  pages: { url: string; title: string }[]
  /** The website as it was read (after redirects), saved as `business_profile.website`. */
  website: string | null
}

export const knowledgeImport = defineAction({
  name: 'knowledge.import',
  description:
    "Write with help: from the owner's description of the business, the goals for the assistant and optionally the business's website (home, services, about, contact and FAQ pages; robots.txt respected), propose an About text, use cases, services with prices and FAQs. Changes nothing: the owner reviews the proposal and saves it with assistant.update.",
  input: z
    .object({
      assistantId: z.string().min(1),
      /** What the business does, its trade and the area it serves, in the owner's words. */
      business: z.string().trim().max(BUSINESS_TEXT_MAX).optional(),
      goals: z.array(z.enum(assistantGoals)).max(assistantGoals.length).default([]),
      goalsNote: z.string().trim().max(1_000).optional(),
      url: z.string().trim().max(2000).optional(),
    })
    .refine(i => i.business || i.url, { message: 'say what the business does, or give its website' }),
  permission: 'settings:write',
  readOnly: true,
})

// --- Documents -----------------------------------------------------------------------------

export const knowledgeAddDocument = defineAction({
  name: 'knowledge.addDocument',
  description: `Add a document (PDF, text or Markdown, up to ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB) the assistant may use as a reference. Its text is extracted on the server; the original is kept in the recording storage in effect, if any.`,
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    mimeType: z.enum(documentTypes),
    /** The file, base64. */
    data: z
      .string()
      .min(1)
      .max(
        Math.ceil((DOCUMENT_MAX_BYTES * 4) / 3) + 4,
        `the file is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB`,
      ),
  }),
  permission: 'settings:write',
  // Megabytes long: kept out of the command log.
  sensitive: ['data'],
})
/** `data` of knowledge.addDocument. */
export type KnowledgeAddDocumentData = { documentId: string; chars: number; truncated: boolean }

export const knowledgeRemoveDocument = defineAction({
  name: 'knowledge.removeDocument',
  description: 'Remove a document from the assistant: its text and the stored original are deleted.',
  input: z.object({ documentId: z.string().min(1) }),
  permission: 'settings:write',
  destructive: true,
})

/**
 * The assistant's documents on a call (`documents` in call.start's data): their text when it is short
 * (`inline`), else `lookUp` and the agent offers the look_up tool. null: no documents.
 */
export type CallDocuments = { inline: string | null; lookUp: boolean }

/** The voice agent's look-up in the documents of the assistant that answers the call. */
export const knowledgeSearch = defineAction({
  name: 'knowledge.search',
  description: "Search the assistant's documents for a caller's question; the best matching passages.",
  input: z.object({ callId: z.string().min(1), query: z.string().trim().min(1).max(300) }),
  permission: 'agent',
  readOnly: true,
})
/** `data` of knowledge.search. */
export type KnowledgeSearchData = { passages: { document: string; text: string }[] }

// --- Questions the assistant could not answer ----------------------------------------------

/** Open questions kept per assistant; older ones beyond it are not added. */
export const OPEN_QUESTIONS_MAX = 30

export const knowledgeQuestionAnswer = defineAction({
  name: 'knowledgeQuestion.answer',
  description:
    "Answer a question a caller asked that the assistant could not answer: it becomes one of the assistant's FAQs.",
  input: z.object({
    questionId: z.string().min(1),
    /** The question as the owner wants it in the FAQs (defaults to the caller's wording). */
    question: z.string().trim().min(1).max(FAQ_QUESTION_MAX).optional(),
    answer: z.string().trim().min(1, 'Write the answer.').max(FAQ_ANSWER_MAX),
  }),
  permission: 'settings:write',
})

export const knowledgeQuestionDismiss = defineAction({
  name: 'knowledgeQuestion.dismiss',
  description: 'Dismiss a question the assistant could not answer, without adding it to the FAQs.',
  input: z.object({ questionId: z.string().min(1) }),
  permission: 'settings:write',
})
