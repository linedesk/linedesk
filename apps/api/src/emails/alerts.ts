// The alerts every server admin gets (admin-alerts.ts sends them) and the other notices about the install: what they
// say, built once per recipient language. A feature hands over the facts (who, which provider, which device); every
// word around them comes from packages/i18n/locales/en/email.json, so each admin reads the whole alert in their own
// language. What the browser, the provider or a person wrote (a user agent, an error message, a name) stays as it is.
import type { ProviderFailureReason } from '@linedesk/actions'
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
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
}

/** A change of email or sign-in settings: they decide how people sign in or get sign-in codes. */
export const settingsChangedAlert =
  ({ change, provider, actor, agent }: SettingsChange): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const values = { change, provider, actor: actorLabel(actor, locale) }
    return {
      subject: t('email.adminAlert.settings.subject', { change, provider, agent: agent ? 'yes' : 'no' }),
      blocks: [
        {
          kind: 'text',
          text: agent
            ? t('email.adminAlert.settings.textAgent', {
                ...values,
                prefix: agent.prefix,
                made: agent.createdAt ? utcTime(agent.createdAt, locale) : '',
                hasMade: agent.createdAt ? 'yes' : 'no',
              })
            : t('email.adminAlert.settings.text', values),
        },
        { kind: 'text', text: t('email.adminAlert.checkProviders') },
        ...(agent ? [{ kind: 'text', text: t('email.adminAlert.settings.agentEnds') } as const] : []),
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
