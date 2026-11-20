// Feedback to the Linedesk team (LIN-639): a bug report, a feature request or feedback on the setup, from the Help
// menu in the web app, an MCP client (`feedback_send`), the API or the `linedesk` CLI. One action for all of them. The
// server masks keys, phone numbers and email addresses in what it keeps and sends, stores the report (table
// `feedback`, not synced) and emails it to FEEDBACK_EMAIL after the commit (apps/api/src/feedback.ts).
import { msg } from '@linedesk/i18n'
import { z } from 'zod'
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

/** What feedback.send answers with (`data`). */
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
  }),
  // Every workspace member, every workspace API key and every MCP client holds call:read (member.list uses it too).
  permission: 'call:read',
  public: true,
  // The report itself is the `feedback` row, masked. The command log keeps only ids (the text is not masked yet when
  // it is logged), and never the image (up to 4 MB) or the sender's address, also not in the input hash.
  logged: 'ids',
  sensitive: ['screenshot', 'contact_email'],
})
