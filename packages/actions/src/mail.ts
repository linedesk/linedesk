import { z } from 'zod'
import type { MailAnalysisError, MailTopic } from '@linedesk/db/types'
import { defineAction } from './define.ts'

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

export { type MailAnalysisError, mailAnalysisErrors, type MailTopic } from '@linedesk/db/types'

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
