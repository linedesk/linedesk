// Call email routing (docs/architecture.md, Notifications; LIN-470, LIN-768): who hears about a call is set in one
// place, Assistant › Who hears about calls. Every member with "Email for every call" on (their own
// member_notification_settings.email, else the team default for new teammates) gets every call email. On top of that,
// each assistant has a short rule list (`assistants.email_rules`, saved with assistant.update): each rule has the calls
// it is about in plain words (`when`), its members (`to`, who get those calls' emails even with "every call" off) and
// whom it assigns (`assign`, one of `to`). After the call a language model only says which rules fit
// (apps/api/src/email-routing.ts); the code picks the recipients and the assignee. Outside addresses
// (email_recipients) stay in the API but the page no longer offers them.
import { z } from 'zod'
import type { EmailRules } from '@linedesk/db/types'
import { defineAction } from './define.ts'

/** The most rules an assistant keeps. */
export const EMAIL_RULES_MAX = 20
/** The longest `when` (the calls a rule is about, in plain words; never empty). */
export const EMAIL_RULE_WHEN_MAX = 300
/** The most members one rule emails. */
export const EMAIL_RULE_TO_MAX = 20
/** No rules: every member with "Email for every call" on gets every call email, nobody else. */
export const NO_EMAIL_RULES: EmailRules = { rules: [] }

const unique = (ids: readonly string[]) => [...new Set(ids)]

/** The rules as saved: members each once, and a rule's assignee only when it is one of its members (else null). */
export function normalizeEmailRules(r: EmailRules): EmailRules {
  return {
    rules: r.rules.map(rule => {
      const to = unique(rule.to)
      return { ...rule, to, assign: rule.assign && to.includes(rule.assign) ? rule.assign : null }
    }),
  }
}

/** Whether an assistant routes its call emails: it has rules. */
export const routesEmails = (r: EmailRules | null | undefined) => !!r && r.rules.length > 0

const memberId = z.string().min(1).max(200)

/** One rule as assistant.update takes it. */
export const emailRuleInput = z.object({
  id: z.string().min(1).max(64),
  when: z.string().trim().min(1).max(EMAIL_RULE_WHEN_MAX),
  to: z.array(memberId).max(EMAIL_RULE_TO_MAX),
  assign: memberId.nullable(),
})

/** assistant.update's `email_rules`, normalized (normalizeEmailRules). */
export const emailRulesInput = z
  .object({ rules: z.array(emailRuleInput).max(EMAIL_RULES_MAX) })
  .transform(normalizeEmailRules)

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

export type EmailRoutingMember = { userId: string; name: string; email: string }

/** What owners and admins read for the rules (emailRouting.get): members' addresses, and whether rules can be matched. */
export type EmailRoutingData = {
  members: EmailRoutingMember[]
  recipients: OutsideRecipient[]
  /** A language model is set up (Server admin › Providers); without one every call goes to the fallback. */
  llm: boolean
}

/** Rejection codes of emailRecipient.* (the API's own English for API clients). */
export const EMAIL_ROUTING_CODES = [
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
    "Read what call email rules may name: the workspace's members (name and email address), its outside addresses (waiting for confirmation, confirmed, stopped or expired) and whether a language model is set up (rules need one).",
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})

/** One member's row in Who hears about calls: whether they get the email about every call. */
export type CallEmailsMember = { userId: string; everyCall: boolean }

/** `data` of callEmails.get. */
export type CallEmailsData = {
  /** The reader's own user id: their row is theirs to switch. */
  you: string
  /** Every member who is not disabled, with their "Email for every call". */
  members: CallEmailsMember[]
  /** The team default: what a new teammate starts with (workspace_settings.notify_email_default). */
  newTeammates: boolean
  /** Rules are on: a language model is set up (Server admin › Providers). Without one only the switches count. */
  llm: boolean
}

/**
 * For every member: Who hears about calls as it is, so everyone sees who gets which call. Changing a switch is
 * notifications.update (your own), team.updateMemberNotifications (a teammate's, owners and admins) and
 * notifications.setDefaults (new teammates).
 */
export const callEmailsGet = defineAction({
  name: 'callEmails.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Read who hears about calls: each member\'s "Email for every call" (`everyCall`), the default new teammates start with (`newTeammates`) and whether call email rules are on (`llm`: a language model is set up; without one the rules in email_rules are ignored). Members with everyCall on get every call email; the members of the rules that fit a call get its email too.',
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})

const outsideEmail = z.string().trim().toLowerCase().pipe(z.email().max(254))

export const emailRecipientAdd = defineAction({
  name: 'emailRecipient.add',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: `Add an email address outside the team for call emails. Call email rules (assistant.update, email_rules) name members only, so it gets none from them for now. It gets a confirmation email; only after it confirms (within ${OUTSIDE_CONFIRM_DAYS} days) does it get call emails, each with a link to stop them. At most ${OUTSIDE_RECIPIENTS_MAX} per workspace and ${OUTSIDE_CONFIRMS_PER_DAY} confirmation emails a day. An address that stopped the emails can be added again ${OUTSIDE_STOP_COOLDOWN_DAYS} days after it stopped.`,
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
