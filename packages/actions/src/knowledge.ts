// Knowledge (docs/architecture.md, Knowledge): what an assistant knows about the business is its
// "About the business" text (`business_profile.instructions`), saved with assistant.update. The "Write with
// help" proposal and the questions callers asked that the assistant could not answer have their own actions.
import { msg } from '@linedesk/i18n'
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
        .transform(list =>
          list.filter((goal): goal is AssistantGoal => (assistantGoals as readonly string[]).includes(goal)),
        ),
      goalsNote: z.string().trim().max(1_000).optional(),
      url: z.string().trim().max(2000).optional(),
    })
    .refine(i => i.business || i.url, { message: msg('server.input.describeBusiness') }),
  permission: 'settings:write',
  readOnly: true,
  // A read is logged only in some cases (run-action.ts runReadOnly); then the website keeps only its host (LIN-507).
  loggedHostOnly: ['url'],
})

// --- Business info: Try a question and help with one answer (LIN-724) --------------------------

/** A question the owner tries, as a caller would ask it. */
export const TRY_QUESTION_MAX = 300

export const knowledgeTry = defineAction({
  name: 'knowledge.try',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Try a question: what the assistant would answer a caller who asks it, from its real call prompt with `instructions` (the About text as drafted, not yet saved) in place of the saved one. Changes nothing. Returns `{ answer }`.',
  input: z.object({
    assistantId: z.string().min(1),
    question: z.string().trim().min(1).max(TRY_QUESTION_MAX),
    /** The About the business text as drafted; the saved one when left out. */
    instructions: z.string().max(20_000).optional(),
  }),
  permission: 'settings:write',
  readOnly: true,
})

/** How a question and answer can be improved with help: two near-duplicates merged, a long one shortened, one translated. */
export const improveKinds = ['merge', 'shorten', 'translate'] as const
export type ImproveKind = (typeof improveKinds)[number]
/** A proposal for one question and answer; nothing is saved until the owner takes it and saves the assistant. */
export type KnowledgeImproveData = { question: string; answer: string }

const improveItem = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX),
  answer: z.string().trim().min(1).max(4_000),
})

export const knowledgeImprove = defineAction({
  name: 'knowledge.improve',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Help with one question and answer of About the business: `merge` two that ask almost the same into one, `shorten` a long answer, or `translate` one into `language`. Changes nothing: returns `{ question, answer }` for the owner to take or not.',
  input: z
    .object({
      assistantId: z.string().min(1),
      kind: z.enum(improveKinds),
      /** One item; two for `merge`. */
      items: z.array(improveItem).min(1).max(2),
      /** For `translate`: the language code to write it in. */
      language: z.string().trim().min(2).max(10).optional(),
    })
    .refine(i => (i.kind === 'merge' ? i.items.length === 2 : i.items.length === 1), {
      message: msg('server.input.improveItems'),
    })
    .refine(i => i.kind !== 'translate' || !!i.language, { message: msg('server.input.improveLanguage') }),
  permission: 'settings:write',
  readOnly: true,
})

// --- Questions the assistant could not answer ----------------------------------------------

/** Open questions kept per assistant; older ones beyond it are not added. */
export const OPEN_QUESTIONS_MAX = 30

/** The other open questions of a group, closed with the one named (at most every open question an assistant keeps). */
const alsoIds = z.array(z.string().min(1)).max(OPEN_QUESTIONS_MAX).default([])

export const knowledgeQuestionAnswer = defineAction({
  name: 'knowledgeQuestion.answer',
  description:
    "Answer a question a caller asked that the assistant could not answer: the question and answer are added to the assistant's About the business text. `alsoIds`: the other questions of its group, closed with it.",
  input: z.object({
    questionId: z.string().min(1),
    /** The question as the owner wants it in the text (defaults to the caller's wording). */
    question: z.string().trim().min(1).max(QUESTION_MAX).optional(),
    answer: z.string().trim().min(1).max(ANSWER_MAX),
    /** The other open questions of its group (evaluation.listQuestions' `questionIds`): answered with it. */
    alsoIds,
  }),
  permission: 'settings:write',
})

export const knowledgeQuestionDismiss = defineAction({
  name: 'knowledgeQuestion.dismiss',
  description:
    'Dismiss a question the assistant could not answer, without adding an answer. `alsoIds`: the other questions of its group, dismissed with it.',
  input: z.object({ questionId: z.string().min(1), alsoIds }),
  permission: 'settings:write',
})
