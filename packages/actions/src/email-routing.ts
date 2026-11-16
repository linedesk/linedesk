// Call email routing (docs/architecture.md, Notifications): each assistant has one plain-language instruction that
// says who gets the email about which call (`assistants.email_routing`, saved with assistant.update). People are
// mentioned in it as `<@user:USER_ID>` (a member) or `<@email:ADDRESS>` (an outside address, email_recipients);
// after the call a language model picks recipients only from the people mentioned (apps/api/src/email-routing.ts).
import { z } from 'zod'
import type { EmailRouteRecipient } from '@linedesk/db/types'
import { defineAction } from './define.ts'

/** The longest instruction (characters, mentions as stored). */
export const EMAIL_ROUTING_MAX = 4000
/** Outside addresses a workspace may keep (removed ones do not count). */
export const OUTSIDE_RECIPIENTS_MAX = 20
/** How long the link in the confirmation email works. */
export const OUTSIDE_CONFIRM_DAYS = 7
/**
 * After an address stopped the emails, it gets no confirmation email again for this long: only removing it and adding
 * it again sends one, and only this many days after `stopped_at`.
 */
export const OUTSIDE_STOP_COOLDOWN_DAYS = 30
/** Confirmation emails per workspace in 24 hours (addresses sent one, removed ones too; counted in the database). */
export const OUTSIDE_CONFIRMS_PER_DAY = 20

/** A mention as stored in the instruction. */
export const MENTION_PATTERN = /<@(user|email):([^>\s]+)>/g

export type Mention = { kind: 'user'; id: string } | { kind: 'email'; email: string }

/** The mentions of an instruction, in order, each once. */
export function parseMentions(text: string | null | undefined): Mention[] {
  const seen = new Set<string>()
  const out: Mention[] = []
  for (const m of (text ?? '').matchAll(MENTION_PATTERN)) {
    const key = `${m[1]}:${m[2]!.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m[1] === 'user' ? { kind: 'user', id: m[2]! } : { kind: 'email', email: m[2]!.toLowerCase() })
  }
  return out
}

export const userMention = (userId: string) => `<@user:${userId}>`
export const emailMention = (email: string) => `<@email:${email.toLowerCase()}>`

/** An instruction that routes: it has text besides blanks. null or '': every member with call emails on. */
export const routesEmails = (text: string | null | undefined) => !!text?.trim()

export type OutsideRecipientStatus = 'waiting' | 'confirmed' | 'stopped' | 'expired'

/** An outside address as owners and admins see it (never its confirmation token). */
export type OutsideRecipient = {
  id: string
  email: string
  label: string | null
  status: OutsideRecipientStatus
  confirmed_at: string | null
  stopped_at: string | null
  confirm_sent_at: string | null
}

export type EmailRoutingMember = { userId: string; name: string; email: string; emailOn: boolean }

/** What the Call emails section reads (emailRouting.get). */
export type EmailRoutingData = {
  members: EmailRoutingMember[]
  recipients: OutsideRecipient[]
  /** A language model is set up (Server admin › Providers); without one every call goes to the fallback. */
  llm: boolean
}

/** One call of the preview (assistant.previewEmailRouting). */
export type EmailRoutingPreviewCall = {
  callId: string
  title: string | null
  started_at: string
  to: EmailRouteRecipient[]
  /** The member it would assign the call to; null: nobody. */
  assign: { user_id: string; name: string } | null
  reason: string | null
  /** Set when the call would go to the fallback (the members with call emails on). */
  problem: 'llm_failed' | 'no_llm' | 'nothing_fit' | null
}

export type EmailRoutingPreview = { calls: EmailRoutingPreviewCall[] }

/** Rejection codes the page words (assistant.previewEmailRouting, emailRecipient.*). */
export const EMAIL_ROUTING_CODES = [
  'preview_limit',
  'recipients_full',
  'recipient_exists',
  'resend_limit',
  'recipient_stopped',
  'confirm_daily_limit',
  'no_email',
  'send_failed',
  'recipient_confirmed',
  'not_found',
  'no_workspace',
] as const
export type EmailRoutingCode = (typeof EMAIL_ROUTING_CODES)[number]

export const emailRoutingGet = defineAction({
  name: 'emailRouting.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Read what the call email instruction may name: the workspace's members (with whether their call emails are on), its outside addresses (waiting for confirmation, confirmed, stopped or expired) and whether a language model is set up.",
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})

const outsideEmail = z.string().trim().toLowerCase().pipe(z.email().max(254))

export const emailRecipientAdd = defineAction({
  name: 'emailRecipient.add',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: `Add an email address outside the team that call email instructions may name. It gets a confirmation email; only after it confirms (within ${OUTSIDE_CONFIRM_DAYS} days) does it get call emails, each with a link to stop them. At most ${OUTSIDE_RECIPIENTS_MAX} per workspace and ${OUTSIDE_CONFIRMS_PER_DAY} confirmation emails a day. An address that stopped the emails can be added again ${OUTSIDE_STOP_COOLDOWN_DAYS} days after it stopped.`,
  input: z.object({ email: outsideEmail, label: z.string().trim().max(80).nullable().optional() }),
  permission: 'settings:write',
})

export const emailRecipientResend = defineAction({
  name: 'emailRecipient.resend',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: `Send the confirmation email to an outside address again (a new link; the old one stops working). Refused for an address that stopped the emails: remove it and add it again, at the earliest ${OUTSIDE_STOP_COOLDOWN_DAYS} days after it stopped.`,
  input: z.object({ id: z.string().min(1) }),
  permission: 'settings:write',
})

export const emailRecipientRemove = defineAction({
  name: 'emailRecipient.remove',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: 'Remove an outside address: it gets no more call emails. emailRecipient.restore undoes it.',
  input: z.object({ id: z.string().min(1) }),
  permission: 'settings:write',
})

export const emailRecipientRestore = defineAction({
  name: 'emailRecipient.restore',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: 'Undo emailRecipient.remove. The address keeps its state (confirmed, waiting or stopped).',
  input: z.object({ id: z.string().min(1) }),
  permission: 'settings:write',
})

export const assistantPreviewEmailRouting = defineAction({
  name: 'assistant.previewEmailRouting',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Try a call email instruction on the assistant's last 5 finished calls: who each would go to, whom it would assign and why. Sends and saves nothing. About 30 previews an hour per workspace.",
  input: z.object({ assistantId: z.string().min(1), text: z.string().max(EMAIL_ROUTING_MAX) }),
  permission: 'settings:write',
  readOnly: true,
})
