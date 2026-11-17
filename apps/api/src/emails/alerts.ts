// The alerts every server admin gets (admin-alerts.ts sends them) and the other notices about the install: what they
// say, built once per recipient language. A feature hands over the facts (who, which provider, which device); every
// word around them comes from packages/i18n/locales/en/email.json, so each admin reads the whole alert in their own
// language. What the browser, the provider or a person wrote (a user agent, an error message, a name) stays as it is.
import type { ProviderFailureReason } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import type { LedgerDifference } from '../ledger.ts'
import type { SignupRuleChange } from '../self-serve.ts'
import { type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { type EmailLocale, WEB_ORIGIN } from './templates.ts'

/** An alert's own content; the frame (eyebrow, button, footer) is added by adminAlertEmail. */
export type AdminAlert = { subject: string; blocks: Block[] }
/** An alert in one admin's language (alertInstanceAdmins builds it per recipient). */
export type AdminAlertText = (locale: EmailLocale) => AdminAlert

/** Who did something an alert is about: an instance admin (their address), or the server operator at the command line. */
export type AlertActor = { operator: true } | { operator?: false; email: string | null }

/** How an email names who did it, in the reader's language. */
export function actorLabel(actor: AlertActor, locale: EmailLocale): string {
  const { t } = getT(locale)
  if (actor.operator) return t('email.adminAlert.actor.operator')
  return actor.email || t('email.fallback.serverAdmin')
}

/** An alert to every server admin: its subject is the heading, its first paragraph the preheader. */
export function adminAlertEmail(alert: AdminAlert, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const first = alert.blocks.find(block => block.kind === 'text')
  return renderEmail({
    locale: lang,
    subject: alert.subject,
    preheader: first?.kind === 'text' ? first.text : alert.subject,
    eyebrow: t('email.adminAlert.eyebrow'),
    heading: alert.subject,
    blocks: [...alert.blocks, { kind: 'button', label: t('email.adminAlert.button'), url: `${origin}/#admin/audit` }],
    reason: t('email.adminAlert.reason', { site: siteHost(origin) }),
    origin,
  })
}

/** A time for an alert read anywhere: the date and time in UTC, in the reader's language. */
const utcTime = (at: Date | string, locale: EmailLocale) => {
  const { t, format } = getT(locale)
  const time = format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
  return t('email.adminAlert.utc', { time })
}

/** The methods a sign-in alert names in words; a provider (Google, GitHub) is named by its brand. */
const SIGN_IN_METHODS = new Set(['passkey', 'authenticator', 'password', 'email_code', 'email_link'])
const PROVIDER_NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub' }

/** A browser and system recognised from a User-Agent ("Chrome", "macOS"), each null when not. */
export type BrowserGuess = { browser: string | null; os: string | null }

export type AdminSignIn = {
  /** The admin's address. */
  who: string
  /** How they signed in (audit.ts signInMethod), 'other' when not recognised, or another word from the request. */
  method: string
  /** Recognised from the User-Agent; null when neither part was. */
  browser: BrowserGuess | null
  /** The raw User-Agent, shortened and without links (plainSnippet); '' when the request had none. */
  userAgent: string
  /** The address, shortened (plainSnippet); '' when unknown. */
  address: string
  at: Date | string
}

/** An admin's passkey check (or, with the rule off, sign-in) from a browser not seen before for them. */
export const adminSignInAlert =
  (s: AdminSignIn): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const unknown = t('email.adminAlert.unknown')
    const method = SIGN_IN_METHODS.has(s.method)
      ? s.method
      : PROVIDER_NAMES[s.method]
        ? 'provider'
        : s.method === 'other' || !s.method
          ? 'unknown'
          : 'raw'
    const browser = s.browser?.browser
      ? s.browser.os
        ? t('email.adminAlert.browserOnOs', { browser: s.browser.browser, os: s.browser.os })
        : s.browser.browser
      : s.browser?.os
        ? t('email.adminAlert.someBrowserOnOs', { os: s.browser.os })
        : s.userAgent || unknown
    return {
      subject: t('email.adminAlert.signIn.subject', { brand: brandName(), who: s.who }),
      blocks: [
        {
          kind: 'text',
          text: t('email.adminAlert.signIn.text', {
            who: s.who,
            method,
            provider: PROVIDER_NAMES[s.method] ?? '',
            how: s.method,
          }),
        },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.signIn.time'), utcTime(s.at, locale)],
            [t('email.adminAlert.signIn.browser'), browser],
            [t('email.adminAlert.signIn.address'), s.address || unknown],
          ],
        },
        { kind: 'text', text: t('email.adminAlert.signIn.ifNot') },
      ],
    }
  }

/** A provider that started failing: its name, why, and what it said last (as the provider wrote it). */
export const providerFailureAlert =
  (provider: string, reason: ProviderFailureReason, message: string): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.providerFailure.subject', { provider, brand: brandName(), reason }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.providerFailure.text', { provider }) },
        ...(message
          ? [{ kind: 'facts', rows: [[t('email.adminAlert.providerFailure.error'), message]] } as const satisfies Block]
          : []),
        { kind: 'text', text: t('email.adminAlert.providerFailure.impact') },
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.providerFailure.once') },
      ],
    }
  }

/** Someone was made an instance admin. */
export const adminGrantedAlert =
  (actor: AlertActor, email: string): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.adminGranted.subject', { brand: brandName(), email }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.adminGranted.text', { actor: actorLabel(actor, locale), email }) },
        { kind: 'text', text: t('email.adminAlert.checkUsers') },
      ],
    }
  }

/** What changed in the email or sign-in settings: a provider's keys, or which mail service sends. */
export type SettingsChange = {
  change: 'changed' | 'removed' | 'switched' | 'cleared'
  /** The provider's name; '' for `cleared`. */
  provider: string
  actor: AlertActor
  /** Set when an AI agent made the change with a setup link: the link's prefix and when it was made. */
  agent: { prefix: string; createdAt: string | null } | null
  /** Billing keys (Stripe): the email says they control money, not sign-in. */
  money?: boolean
}

/** A change of email or sign-in settings: they decide how people sign in or get sign-in codes. */
export const settingsChangedAlert =
  ({ change, provider, actor, agent, money }: SettingsChange): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const values = { change, provider, actor: actorLabel(actor, locale) }
    const agentValues = agent && {
      ...values,
      prefix: agent.prefix,
      made: agent.createdAt ? utcTime(agent.createdAt, locale) : '',
      hasMade: agent.createdAt ? 'yes' : 'no',
    }
    const text = money
      ? agentValues
        ? t('email.adminAlert.settings.moneyTextAgent', agentValues)
        : t('email.adminAlert.settings.moneyText', values)
      : agentValues
        ? t('email.adminAlert.settings.textAgent', agentValues)
        : t('email.adminAlert.settings.text', values)
    return {
      subject: t('email.adminAlert.settings.subject', { change, provider, agent: agent ? 'yes' : 'no' }),
      blocks: [
        { kind: 'text', text },
        { kind: 'text', text: t('email.adminAlert.checkProviders') },
        ...(agent ? [{ kind: 'text', text: t('email.adminAlert.settings.agentEnds') } as const] : []),
      ],
    }
  }

/** Billing was turned on or off (billingEnabled.set): on, businesses are charged; off, nothing is. */
export const billingSwitchAlert =
  ({
    on,
    actor,
    account,
    mode,
  }: {
    on: boolean
    actor: AlertActor
    account: string | null
    mode: 'test' | 'live' | null
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const values = { on: on ? 'yes' : 'no', actor: actorLabel(actor, locale), account: account ?? '', mode: mode ?? '' }
    return {
      subject: t('email.adminAlert.billingSwitch.subject', values),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingSwitch.text', values) },
        { kind: 'text', text: t('email.adminAlert.checkProviders') },
      ],
    }
  }

/** The install's billing rules changed (Server admin › Billing): every instance admin hears which fields. */
export const billingRulesAlert =
  ({ actor, fields, reason }: { actor: AlertActor; fields: string[]; reason: string }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const values = {
      actor: actorLabel(actor, locale),
      fields: fields.length ? fields.join(', ') : t('email.adminAlert.billingRules.reset'),
      reason,
    }
    return {
      subject: t('email.adminAlert.billingRules.subject'),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingRules.text', values) },
        { kind: 'text', text: t('email.adminAlert.checkBilling') },
      ],
    }
  }

/** Self-serve sign-up turned on or off (Server admin › Billing, `signup.selfServe`). */
export const selfServeAlert =
  ({ actor, on, reason }: { actor: AlertActor; on: boolean; reason: string }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const values = { actor: actorLabel(actor, locale), on: on ? 'yes' : 'no', reason }
    return {
      subject: t('email.adminAlert.selfServe.subject', values),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.selfServe.text', values) },
        { kind: 'text', text: t('email.adminAlert.checkBilling') },
      ],
    }
  }

/**
 * The install's sign-up limits changed (Server admin › Billing, `signup.rules`): every instance admin hears each rule
 * with its old and new value, in plain words when a safeguard was loosened (the bot check off, no Radar level held for
 * review), and that sign-up is now open when this change opened it (security review of #1097, L-1).
 */
export const signupRulesAlert =
  ({
    actor,
    changes,
    opened,
    reason,
  }: {
    actor: AlertActor
    changes: SignupRuleChange[]
    opened: boolean
    reason: string
  }): AdminAlertText =>
  locale => {
    const { t, format } = getT(locale)
    const value = (v: number | boolean | string[]) =>
      typeof v === 'boolean'
        ? t(v ? 'email.adminAlert.signupRules.on' : 'email.adminAlert.signupRules.off')
        : typeof v === 'number'
          ? format.number(v)
          : v.length
            ? format.list(v, { type: 'unit', style: 'short' })
            : t('email.adminAlert.signupRules.none')
    const row = (c: SignupRuleChange): [string, string] => {
      const label = t(SIGNUP_RULE_LABELS[c.field])
      if (c.field === 'blockedDomains') {
        const added = c.to.filter(d => !c.from.includes(d)).length
        const removed = c.from.filter(d => !c.to.includes(d)).length
        return [label, t('email.adminAlert.signupRules.domains', { added, removed })]
      }
      return [label, t('email.adminAlert.signupRules.fromTo', { from: value(c.from), to: value(c.to) })]
    }
    const botCheckOff = changes.some(c => c.field === 'turnstile' && c.from && !c.to)
    const noReview = changes.some(c => c.field === 'reviewRiskLevels' && c.from.length > 0 && c.to.length === 0)
    const text = (key: MessageKey): Block => ({ kind: 'text', text: t(key) })
    return {
      subject: t(opened ? 'email.adminAlert.signupRules.subjectOpened' : 'email.adminAlert.signupRules.subject'),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.signupRules.text', { actor: actorLabel(actor, locale), reason }) },
        ...(opened ? [text(msg('email.adminAlert.signupRules.opened'))] : []),
        ...(botCheckOff ? [text(msg('email.adminAlert.signupRules.botCheckOff'))] : []),
        ...(noReview ? [text(msg('email.adminAlert.signupRules.noReview'))] : []),
        ...(changes.length ? [{ kind: 'facts', rows: changes.map(row) } as const satisfies Block] : []),
        text(msg('email.adminAlert.checkBilling')),
      ],
    }
  }

/** How the email names each sign-up rule. */
const SIGNUP_RULE_LABELS: Record<SignupRuleChange['field'], MessageKey> = {
  codesPerAddressHour: msg('email.adminAlert.signupRules.field.codesPerAddressHour'),
  codesPerAddressDay: msg('email.adminAlert.signupRules.field.codesPerAddressDay'),
  signupsPerIpHour: msg('email.adminAlert.signupRules.field.signupsPerIpHour'),
  signupsPerIpDay: msg('email.adminAlert.signupRules.field.signupsPerIpDay'),
  codesPerInstallHour: msg('email.adminAlert.signupRules.field.codesPerInstallHour'),
  pendingDays: msg('email.adminAlert.signupRules.field.pendingDays'),
  turnstile: msg('email.adminAlert.signupRules.field.turnstile'),
  blockedDomains: msg('email.adminAlert.signupRules.field.blockedDomains'),
  trialWorkspacesCloud: msg('email.adminAlert.signupRules.field.trialWorkspacesCloud'),
  trialWorkspacesPartner: msg('email.adminAlert.signupRules.field.trialWorkspacesPartner'),
  trialNumbersPerWorkspace: msg('email.adminAlert.signupRules.field.trialNumbersPerWorkspace'),
  reviewRiskLevels: msg('email.adminAlert.signupRules.field.reviewRiskLevels'),
}

/** The nightly billing check found ledger guards missing or sums that do not add up (ledger.ts `checkLedger`). */
export const ledgerCheckAlert =
  ({
    guardsMissing,
    differences,
    failed = false,
  }: {
    guardsMissing: string[]
    differences: LedgerDifference[]
    /** The check itself threw: it found nothing, and nobody would hear of it otherwise. */
    failed?: boolean
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    if (failed)
      return {
        subject: t('email.adminAlert.ledgerCheck.failedSubject', { brand: brandName() }),
        blocks: [
          { kind: 'text', text: t('email.adminAlert.ledgerCheck.failed') },
          { kind: 'text', tone: 'muted', text: t('email.adminAlert.ledgerCheck.nightly') },
        ],
      }
    const rows = differences.map((d): [string, string] => [
      t('email.adminAlert.ledgerCheck.kind', { kind: d.kind }),
      d.kind === 'uncredited'
        ? t('email.adminAlert.ledgerCheck.uncredited', { bill: d.bill, recharge: d.recharge })
        : d.kind === 'balance' || d.kind === 'reserved'
          ? t('email.adminAlert.ledgerCheck.bill', { bill: d.bill, found: d.found, expected: d.expected })
          : t('email.adminAlert.ledgerCheck.counter', { ...d }),
    ])
    return {
      subject: t('email.adminAlert.ledgerCheck.subject', {
        brand: brandName(),
        count: guardsMissing.length + differences.length,
      }),
      blocks: [
        ...(guardsMissing.length
          ? [
              { kind: 'text', text: t('email.adminAlert.ledgerCheck.guards') } as const,
              {
                kind: 'facts',
                rows: guardsMissing.map((g): [string, string] => [t('email.adminAlert.ledgerCheck.guard'), g]),
              } as const,
            ]
          : []),
        ...(rows.length
          ? [{ kind: 'text', text: t('email.adminAlert.ledgerCheck.sums') } as const, { kind: 'facts', rows } as const]
          : []),
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.ledgerCheck.nightly') },
      ],
    }
  }

/** A call reported more seconds than its limit plus the grace, so its bill was capped (ledger.ts `postCallUsage`). */
export const cappedCallAlert =
  ({
    bill,
    call,
    reported,
    billed,
  }: {
    bill: string
    call: string
    reported: number
    billed: number
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.cappedCall.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.cappedCall.text', { reported, billed }) },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.cappedCall.bill'), bill],
            [t('email.adminAlert.cappedCall.call'), call],
          ],
        },
        { kind: 'text', text: t('email.adminAlert.cappedCall.check') },
      ],
    }
  }

/**
 * Billing is switched on but cannot run (call-billing.ts `billOfCall`): calls of workspaces on a bill are refused until
 * it works again. Once per streak.
 */
export const billingUnusableAlert =
  (reason: 'guards' | 'keys'): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.billingUnusable.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingUnusable.text', { reason }) },
        { kind: 'text', text: t('email.adminAlert.billingUnusable.fix') },
      ],
    }
  }

/** Recharge attempts still pending after STUCK_RECHARGE_MS (billing-recharge.ts `stuckRecharges`). */
export const stuckRechargesAlert =
  (stuck: { recharge: string; bill: string; since: string }[]): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.stuckRecharges.subject', { brand: brandName(), count: stuck.length }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.stuckRecharges.text') },
        {
          kind: 'facts',
          rows: stuck.map((s): [string, string] => [
            s.recharge,
            t('email.adminAlert.stuckRecharges.row', { bill: s.bill, since: utcTime(s.since, locale) }),
          ]),
        },
        { kind: 'text', text: t('email.adminAlert.stuckRecharges.check') },
      ],
    }
  }

/**
 * A bill's extra calls at the same time could not be set in Stripe after a change (extra-calls.ts
 * `syncExtraCallsItem`): Stripe charges for another number of extra calls than the app grants.
 */
export const extraCallsSyncAlert =
  (bill: string): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.extraCallsSync.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.extraCallsSync.text', { bill }) },
        { kind: 'text', text: t('email.adminAlert.extraCallsSync.fix') },
      ],
    }
  }

/** Every passkey of an account was removed (user.resetPasskeys). */
export const passkeysResetAlert =
  (actor: AlertActor, email: string, removed: number, isAdmin: boolean): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.passkeysReset.subject', { brand: brandName(), email }),
      blocks: [
        {
          kind: 'text',
          text: t('email.adminAlert.passkeysReset.text', { actor: actorLabel(actor, locale), email, count: removed }),
        },
        ...(isAdmin ? [{ kind: 'text', text: t('email.adminAlert.passkeysReset.admin') } as const] : []),
        { kind: 'text', text: t('email.adminAlert.checkAudit') },
      ],
    }
  }

/** A code for an instance admin's first passkey was issued (user.issuePasskeyEnrolment). */
export const enrolmentIssuedAlert =
  (actor: AlertActor, email: string): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.enrolmentIssued.subject', { brand: brandName(), email }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.enrolmentIssued.text', { actor: actorLabel(actor, locale), email }) },
        { kind: 'text', text: t('email.adminAlert.checkAudit') },
      ],
    }
  }

// ---------------------------------------------------------------- spending cap

export type SpendingCapEmail = {
  /** Email-safe (emailSafeName); null: the workspace has no usable name. */
  workspace: string | null
  /** 80 or 100 (spending-cap.ts SPENDING_ALERT_LEVELS). */
  level: number
  capUsd: number
  spentUsd: number
}

/** A workspace used 80 % of its monthly spending cap, or reached it; the same email for owners and instance admins. */
export function spendingCapEmail(
  { workspace, level, capUsd, spentUsd }: SpendingCapEmail,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const name = workspace ?? t('email.spendingCap.fallbackWorkspace')
  const values = {
    workspace: name,
    cap: format.currency(capUsd, 'USD'),
    spent: format.currency(spentUsd, 'USD'),
    percent: format.number(level / 100, { style: 'percent' }),
  }
  const reached = level >= 100
  const subject = reached ? t('email.spendingCap.reachedSubject', values) : t('email.spendingCap.levelSubject', values)
  return renderEmail({
    locale: lang,
    subject,
    preheader: reached ? t('email.spendingCap.reachedText', values) : t('email.spendingCap.levelText', values),
    eyebrow: t('email.spendingCap.eyebrow'),
    ...(reached ? { urgent: t('email.spendingCap.urgent') } : {}),
    heading: subject,
    blocks: [
      {
        kind: 'text',
        text: reached ? t('email.spendingCap.reachedText', values) : t('email.spendingCap.levelText', values),
      },
      { kind: 'text', text: reached ? t('email.spendingCap.reachedEffect') : t('email.spendingCap.levelEffect') },
      { kind: 'text', tone: 'muted', text: t('email.spendingCap.change', values) },
    ],
    reason: t('email.spendingCap.reason', { workspace: name, site: siteHost(origin) }),
    origin,
  })
}

// ---------------------------------------------------------------- install setup

/** How long the code of the setup's test email works (install-setup.ts). */
export const TEST_EMAIL_MINUTES = 10

/** The setup's email test (Server admin › Setup): a code that proves the email arrived. */
export function installTestEmail(code: string, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
  const site = siteHost(origin)
  return renderEmail({
    locale: lang,
    subject: t('email.installTest.subject', { code, brand }),
    preheader: t('email.installTest.preheader', { minutes: TEST_EMAIL_MINUTES }),
    heading: t('email.installTest.heading'),
    blocks: [
      { kind: 'text', text: t('email.installTest.text') },
      { kind: 'code', code },
      { kind: 'text', tone: 'muted', text: t('email.installTest.note', { minutes: TEST_EMAIL_MINUTES }) },
    ],
    reason: t('email.installTest.reason', { site, brand }),
    origin,
  })
}

/**
 * The daily sign-up sweep kept a bill that still waits for Checkout (signup-handlers.ts): a linked Stripe subscription
 * or a confirmed Checkout in our database (review of #919 N2), a running subscription or a completed Checkout that
 * only Stripe shows yet (`in_stripe`, V-1), or Stripe could not be asked (`stripe_error`).
 */
export const signupKeptAlert =
  (kept: {
    bill: string
    subscription: string | null
    reason?: 'in_stripe' | 'stripe_error'
    customer?: string
    session?: string | null
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const { bill, subscription, reason, customer, session } = kept
    const line = (text: string) => ({ kind: 'text' as const, text })
    const ids = [
      line(t('email.adminAlert.signupKept.bill', { bill })),
      ...(customer ? [line(t('email.adminAlert.signupKept.customer', { customer }))] : []),
    ]
    if (reason === 'stripe_error')
      return {
        subject: t('email.adminAlert.signupKept.stripeError.subject', { brand: brandName() }),
        blocks: [
          line(t('email.adminAlert.signupKept.stripeError.text')),
          ...ids,
          line(t('email.adminAlert.signupKept.stripeError.check')),
        ],
      }
    const inStripe = reason === 'in_stripe'
    return {
      subject: t('email.adminAlert.signupKept.subject', { brand: brandName() }),
      blocks: [
        line(inStripe ? t('email.adminAlert.signupKept.inStripe.text') : t('email.adminAlert.signupKept.text')),
        ...ids,
        ...(subscription ? [line(t('email.adminAlert.signupKept.subscription', { subscription }))] : []),
        ...(session ? [line(t('email.adminAlert.signupKept.session', { session }))] : []),
        line(inStripe ? t('email.adminAlert.signupKept.inStripe.check') : t('email.adminAlert.signupKept.check')),
      ],
    }
  }

/** The install's hourly cap on sign-up codes was reached (self-serve.ts): more are refused this hour. Once an hour. */
export const signupCapAlert =
  (cap: number): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.signupCap.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.signupCap.text', { cap }) },
        { kind: 'text', text: t('email.adminAlert.signupCap.check') },
      ],
    }
  }
