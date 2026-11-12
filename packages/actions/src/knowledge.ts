// Knowledge (docs/architecture.md, Knowledge): what an assistant knows about the business is its
// "About the business" text (`business_profile.instructions`), saved with assistant.update. The "Write with
// help" proposal and the questions callers asked that the assistant could not answer have their own actions.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** A question a caller asked, and its answer, as the owner may write them. */
export const QUESTION_MAX = 300
export const ANSWER_MAX = 1000

/** How an answered question is added to the About text: one line the assistant can answer from. */
export const answeredQuestionLine = (question: string, answer: string) =>
  `If a caller asks "${question.replace(/\s+/g, ' ').trim()}": ${answer.replace(/\s+/g, ' ').trim()}`

/**
 * Untrusted text (a website, the owner's notes) put between our tags: any opening or closing tag with those
 * names, with or without attributes or spaces (`</page x>`, `< /page>`), is defused so the text cannot end the
 * fence early.
 */
export function fenceData(text: string, tags: readonly string[]): string {
  const names = tags.map(t => t.replace(/[^a-z_]/gi, '')).join('|')
  return text.replace(new RegExp(`<\\s*\\/?\\s*(${names})\\b[^<>]*>?`, 'gi'), m =>
    m.replace(/</g, '‹').replace(/>/g, '›'),
  )
}

// --- Website import ------------------------------------------------------------------------

/** What the assistant should do on calls, as the "Write with help" wizard offers them. */
export const assistantGoals = ['messages', 'booking', 'prices', 'spam'] as const
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
  /** The pages that were read, for the review. */
  pages: { url: string; title: string }[]
  /** The website as it was read (after redirects), saved as `business_profile.website`. */
  website: string | null
}

export const knowledgeImport = defineAction({
  name: 'knowledge.import',
  description:
    "Write with help: from the owner's description of the business, the goals for the assistant and optionally the business's website (home, services, about, contact and FAQ pages; robots.txt respected), propose an About text and use cases. Changes nothing: the owner reviews the proposal and saves it with assistant.update.",
  input: z
    .object({
      assistantId: z.string().min(1),
      /** What the business does, its trade and the area it serves, in the owner's words. */
      business: z.string().trim().max(BUSINESS_TEXT_MAX).optional(),
      // A goal that was removed ("emergencies") from an older web app is left out.
      goals: z
        .array(z.string())
        .max(10)
        .default([])
        .transform(list => list.filter((goal): goal is AssistantGoal => (assistantGoals as readonly string[]).includes(goal))),
      goalsNote: z.string().trim().max(1_000).optional(),
      url: z.string().trim().max(2000).optional(),
    })
    .refine(i => i.business || i.url, { message: 'say what the business does, or give its website' }),
  permission: 'settings:write',
  readOnly: true,
})

// --- Questions the assistant could not answer ----------------------------------------------

/** Open questions kept per assistant; older ones beyond it are not added. */
export const OPEN_QUESTIONS_MAX = 30

export const knowledgeQuestionAnswer = defineAction({
  name: 'knowledgeQuestion.answer',
  description:
    "Answer a question a caller asked that the assistant could not answer: the question and answer are added to the assistant's About the business text.",
  input: z.object({
    questionId: z.string().min(1),
    /** The question as the owner wants it in the text (defaults to the caller's wording). */
    question: z.string().trim().min(1).max(QUESTION_MAX).optional(),
    answer: z.string().trim().min(1, 'Write the answer.').max(ANSWER_MAX),
  }),
  permission: 'settings:write',
})

export const knowledgeQuestionDismiss = defineAction({
  name: 'knowledgeQuestion.dismiss',
  description: 'Dismiss a question the assistant could not answer, without adding an answer.',
  input: z.object({ questionId: z.string().min(1) }),
  permission: 'settings:write',
})
