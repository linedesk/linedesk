// Feedback to the Linedesk team (LIN-639): a bug report, a feature request or feedback on the setup, from the Help
// menu in the web app, an MCP client (`feedback_send`), the API or the `linedesk` CLI. One action for all of them. The
// server masks keys, phone numbers and email addresses in what it keeps and sends, stores the report (table
// `feedback`, not synced) and emails it to FEEDBACK_EMAIL after the commit (apps/api/src/feedback.ts).
//
// A setup report (LIN-208/210) is feedback.send with `kind: setup` and `setup` from an install setup link's agent: the
// structured report of the setup-feedback contract (outcome and items). The setup MCP shows the agent the redacted
// report first and sends it only with `user_consented: true`; the server then sends it to SETUP_FEEDBACK_URL, not by
// email (apps/api/src/setup-feedback.ts).
import { msg } from '@linedesk/i18n'
import { z } from 'zod'
import type { AgentClient } from './agent-setup.ts'
import { defineAction } from './define.ts'

export const FEEDBACK_KINDS = ['bug', 'feature', 'setup'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_TEXT_MAX = 5000
export const FEEDBACK_PAGE_MAX = 300
export const FEEDBACK_ERRORS_MAX = 8000
/** The largest screenshot, decoded (a PNG or JPEG of the page). */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024
/** Reports one person or key may send: per hour, and the shortest gap between two. */
export const FEEDBACK_PER_HOUR = 10
export const FEEDBACK_MIN_GAP_SECONDS = 10
/** The refusal code when the limit is reached (the server's words are in the caller's language). */
export const FEEDBACK_RATE_LIMITED = 'feedback_rate_limited'

const SCREENSHOT = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/
const SCREENSHOT_MAX_CHARS = 'data:image/jpeg;base64,'.length + Math.ceil(FEEDBACK_SCREENSHOT_MAX_BYTES / 3) * 4

/** A setup report's outcome, its items' categories and severities (the setup-feedback contract v1, LIN-208). */
export const SETUP_REPORT_OUTCOMES = ['in_progress', 'completed', 'partial', 'abandoned'] as const
export const SETUP_REPORT_CATEGORIES = [
  'bug',
  'blocked',
  'confusing',
  'slow',
  'docs',
  'suggestion',
  'went_well',
] as const
export const SETUP_REPORT_SEVERITIES = ['low', 'medium', 'high', 'blocker'] as const
export const SETUP_REPORT_MAX_ITEMS = 10
/** The longest summary a setup report carries (`text` is cut to it). */
export const SETUP_REPORT_SUMMARY_MAX = 500
/** Setup reports one setup link may send: per day, and the shortest gap between two. */
export const SETUP_REPORTS_PER_DAY = 10
export const SETUP_REPORT_MIN_GAP_SECONDS = 60

// i18n-ignore: field docs for agents (MCP and API), not shown in the app
const setupItem = z.object({
  category: z
    .enum(SETUP_REPORT_CATEGORIES)
    .describe('bug, blocked, confusing, slow, docs (the docs or instructions were wrong), suggestion or went_well'),
  step: z.string().trim().max(40).optional().describe('The setup step it is about: a step id from setup_status'),
  tool: z.string().trim().max(60).optional().describe('The tool involved, if any, e.g. provider_setKeys'),
  what_happened: z.string().trim().min(1).max(1000).describe('What happened, in plain words'),
  expected: z.string().trim().max(500).optional().describe('What you expected instead'),
  time_lost_minutes: z.number().int().min(0).max(240).optional().describe('Your estimate of the minutes lost'),
  severity: z.enum(SETUP_REPORT_SEVERITIES),
  error_code: z.string().trim().max(60).optional().describe('An error code or HTTP status, if there was one'),
  error_excerpt: z.string().trim().max(500).optional().describe('A short excerpt of the error message'),
})

/** What feedback.send answers with (`data`). A setup report's preview (no `user_consented`) has no id yet. */
export type FeedbackSendData = { id: string }

export const feedbackSend = defineAction({
  name: 'feedback.send',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Send feedback to the Linedesk team (the people who make Linedesk, not this workspace's team): a bug report (`kind: bug`), a feature request (`feature`) or feedback on setting Linedesk up (`setup`). `text` says in plain words what happened or what is wanted (at most 5000 characters); `page` can name the app page it is about. Send it only when the user asks you to report something. Never put API keys, passwords, phone numbers, email addresses or details of callers or customers in it: the server masks what it recognises, not everything. Set `contact_email` only when the user wants an answer at that address. Answers with the feedback's `id`. At most 10 an hour.",
  input: z.object({
    kind: z.enum(FEEDBACK_KINDS),
    text: z.string().trim().min(1).max(FEEDBACK_TEXT_MAX),
    page: z.string().trim().max(FEEDBACK_PAGE_MAX).optional(),
    context: z
      .object({
        version: z.string().trim().max(100).optional(),
        browser: z.string().trim().max(300).optional(),
        errors: z.string().trim().max(FEEDBACK_ERRORS_MAX).optional(),
      })
      .optional(),
    screenshot: z
      .string()
      .max(SCREENSHOT_MAX_CHARS, msg('server.input.screenshotTooLarge'))
      .regex(SCREENSHOT, msg('server.input.screenshotFormat'))
      .optional(),
    contact_email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
    // i18n-ignore: field docs for agents (MCP and API), not shown in the app
    setup: z
      .object({
        outcome: z.enum(SETUP_REPORT_OUTCOMES).describe('in_progress, completed, partial or abandoned'),
        items: z
          .array(setupItem)
          .max(SETUP_REPORT_MAX_ITEMS)
          .default([])
          .describe('What went wrong, was slow or went well, at most 10; empty with outcome completed: all went well'),
        agent_model: z.string().trim().max(80).optional().describe('Your own model name, if you know it'),
      })
      .optional()
      .describe('Only through a setup link (setup MCP), with kind setup: the structured setup report'),
    user_consented: z
      .boolean()
      .optional()
      .describe('Only through a setup link: true once the admin saw the preview and said yes to sending it'),
    // i18n-ignore: field docs for agents (MCP and API), not shown in the app
    preview_token: z
      .string()
      .max(200)
      .optional()
      .describe("Only through a setup link, with user_consented: the preview's preview_token the admin said yes to"),
  }),
  // Every workspace member, every workspace API key and every MCP client holds call:read (member.list uses it too).
  permission: 'call:read',
  public: true,
  // The report itself is the `feedback` row, masked. The command log keeps only ids (the text is not masked yet when
  // it is logged), and never the image (up to 4 MB) or the sender's address, also not in the input hash.
  logged: 'ids',
  sensitive: ['screenshot', 'contact_email'],
})

/**
 * Sends a kept setup report to the Linedesk team again (Server admin › System › Setup reports, LIN-210): the admin's
 * own click, so it does not count against the setup link's limit. Not for a report that was sent or refused.
 */
export const feedbackResend = defineAction({
  name: 'feedback.resend',
  // i18n-ignore: API docs for developers, not shown in the app
  description: 'Send a kept setup report to the Linedesk team again (Server admin › System › Setup reports).',
  input: z.object({ id: z.string().trim().min(1).max(64) }),
  permission: 'instance:admin',
})

/** One setup report in Server admin › System › Setup reports (feedback.setupReports). */
export type SetupReportRow = {
  id: string
  createdAt: string
  outcome: string
  items: number
  /** The agent the admin picked for the setup link, null when unknown. */
  agent: AgentClient | null
  status: 'pending' | 'sent' | 'kept' | 'failed' | 'refused'
  /** Why it is not sent: sending is off here, the team's server could not be reached yet, or it refused it. */
  reason: 'off' | 'unreachable' | 'refused' | null
  /** The technical detail of the last try (masked, for the tooltip), or null. */
  detail: string | null
  tries: number
  sentAt: string | null
}
export type SetupReportsData = { reports: SetupReportRow[]; sendingOff: boolean }

/** The latest setup reports of this install, newest first (Server admin › System › Setup reports, LIN-210). */
export const feedbackSetupReports = defineAction({
  name: 'feedback.setupReports',
  // i18n-ignore: API docs for developers, not shown in the app
  description: "The install's latest setup reports from AI agents (at most 50): when, outcome, items and whether sent.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
