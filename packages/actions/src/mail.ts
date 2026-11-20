import { msg } from '@linedesk/i18n'
import { z } from 'zod'
import type { MailAnalysisError, MailTopic } from '@linedesk/db/types'
import { defineAction } from './define.ts'
import { ANSWER_MAX, answeredQuestionLine, QUESTION_MAX } from './knowledge.ts'

// Support mailboxes (LIN-615): a business connects the mailbox its support answers from, read only, so Linedesk can
// learn the typical customer requests and how they are answered. Gmail and Microsoft 365 connect by OAuth:
// mail.connectStart returns the provider's consent URL; the provider sends the browser back to
// GET /v1/mail/callback/<provider>, which runs mail.connectFinish for the signed-in member. Connecting stores no mail.

export const mailProvider = z.enum(['google', 'microsoft'])
export type MailProviderId = z.infer<typeof mailProvider>

/**
 * Why connecting or disconnecting a mailbox did not work: the `reason` of the OAuth callback's redirect and the `code`
 * of the actions' rejections. The page words each one (an unknown code gets the generic text), so no server text
 * reaches the page and nobody can put their own text into the redirect.
 */
export const mailConnectErrors = [
  'denied',
  'signed_out',
  'expired',
  'other_workspace',
  'scope',
  'no_grant',
  'not_set_up',
  'no_secrets_key',
  'api_disabled',
  'app_refused',
  'account_refused',
  'unavailable',
  'not_connected',
  'failed',
] as const
export type MailConnectError = (typeof mailConnectErrors)[number]
export const isMailConnectError = (value: unknown): value is MailConnectError =>
  (mailConnectErrors as readonly unknown[]).includes(value)

export const mailConnectStart = defineAction({
  name: 'mail.connectStart',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Start connecting a support mailbox (Gmail or Microsoft 365) with read-only access. Returns the URL of the provider's consent page.",
  input: z.object({ provider: mailProvider }),
  permission: 'settings:write',
})

/** `data` of mail.connectStart. */
export type MailConnectStartData = { url: string }

export const mailConnectFinish = defineAction({
  name: 'mail.connectFinish',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Finish connecting a support mailbox with the code the provider sent back. Run by the OAuth callback route.',
  input: z.object({
    provider: mailProvider,
    state: z.string().min(16).max(200),
    code: z.string().min(1).max(4000),
  }),
  permission: 'settings:write',
  sensitive: ['code', 'state'],
})

/** `data` of mail.connectFinish. */
export type MailConnectFinishData = { connectionId: string }

export const mailDisconnect = defineAction({
  name: 'mail.disconnect',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Disconnect a support mailbox: its access is revoked at the provider where possible and its tokens deleted. Nothing in the mailbox changes.',
  input: z.object({ connectionId: z.string().min(1) }).strict(),
  permission: 'settings:write',
})

/** `data` of mail.disconnect: whether the provider withdrew the grant (Microsoft has no way to). */
export type MailDisconnectData = { revoked: boolean }

// Support mail analysis (LIN-642, step 2 of LIN-615): a job reads the last months of the connected mailboxes' support
// conversations (those support answered), takes the personal data out, and asks the language model in effect for the
// most common kinds of requests, how support answers each and what it needs to know from the customer. Only that
// result is stored (mail_analyses), never a message.

/** How far back an analysis reads, in months. */
export const MAIL_ANALYSIS_MONTHS = [6, 12] as const
/** The kinds of requests an analysis keeps, most common first. */
export const MAIL_TOPICS_MAX = 10
/** Analyses a workspace may start in a day: each reads up to a year of mail and costs language-model requests. */
export const MAIL_ANALYSES_PER_DAY = 3

export { type MailAnalysisError, mailAnalysisErrors, type MailTopic, type MailTopicReview } from '@linedesk/db/types'

export type MailAnalysisStatus = 'queued' | 'running' | 'done' | 'failed'

/** An analysis: `data.analysis` of mail.analyze and mail.getAnalysis (null when there is none). */
export type MailAnalysis = {
  id: string
  status: MailAnalysisStatus
  months: number
  /** Conversations read, and of those the support conversations analyzed (answered by the mailbox). */
  conversationsRead: number
  conversationsAnalyzed: number
  topics: MailTopic[]
  error: MailAnalysisError | null
  model: string | null
  createdAt: string
  finishedAt: string | null
}

export const mailAnalyze = defineAction({
  name: 'mail.analyze',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Analyze the support mail of the workspace's connected mailboxes (last 6 or 12 months) in the background: the most common kinds of customer requests, how support answers each, and what it needs to know from the customer. Personal data is removed before the language model reads the mail; only the result is stored. Read it with mail.getAnalysis.",
  input: z.object({ months: z.union([z.literal(6), z.literal(12)]).default(12) }).strict(),
  permission: 'settings:write',
})

export const mailGetAnalysis = defineAction({
  name: 'mail.getAnalysis',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The workspace's latest support mail analysis (mail.analyze): its status and, when done, the most common kinds of requests with how support answers them and the facts it needs.",
  input: z.object({}).strict(),
  permission: 'settings:write',
})

// Owner review (LIN-643, step 3 of LIN-615): the owner accepts, edits or drops each topic of a finished analysis. An
// accepted topic becomes one line in an assistant's About the business: the question and support's answer, as an
// answered caller question is written (answeredQuestionLine), plus what to ask the caller for where support needs it.

/** Facts to ask for, kept per topic, and the length of each. */
export const MAIL_FACTS_MAX = 10
export const MAIL_FACT_MAX = 160

/** The line an accepted topic adds to About the business (text the assistant reads). */
export function mailTopicLine(question: string, answer: string, facts: readonly string[]): string {
  const asked = facts
    .map(f =>
      f
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.;]+$/, ''),
    )
    .filter(Boolean)
  const line = answeredQuestionLine(question, answer)
  // i18n-ignore: text the assistant reads, not UI (rule 11; wording approved by Tim on 2026-11-21)
  return asked.length ? `${line} To help, ask the caller for: ${asked.join('; ')}.` : line
}

export const mailReviewTopic = defineAction({
  name: 'mail.reviewTopic',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Review one topic of the workspace's latest finished support mail analysis (mail.getAnalysis; `index` counts from 0). `accept` adds it to the assistant's About the business as one line: the question, the answer and the facts to ask the caller for (each as the owner edited it); an accepted topic stays accepted. `drop` leaves it out; `reopen` takes a drop back.",
  input: z
    .object({
      analysisId: z.string().min(1),
      index: z
        .number()
        .int()
        .min(0)
        .max(MAIL_TOPICS_MAX - 1),
      decision: z.enum(['accept', 'drop', 'reopen']),
      /** accept: the assistant whose About the business gets the line. */
      assistantId: z.string().min(1).optional(),
      question: z.string().trim().min(1).max(QUESTION_MAX).optional(),
      answer: z.string().trim().min(1).max(ANSWER_MAX).optional(),
      factsNeeded: z.array(z.string().trim().min(1).max(MAIL_FACT_MAX)).max(MAIL_FACTS_MAX).default([]),
    })
    .strict()
    .refine(i => i.decision !== 'accept' || (i.assistantId && i.question && i.answer), {
      message: msg('server.input.mail.acceptNeeds'),
    }),
  permission: 'settings:write',
})
