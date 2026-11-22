// Every email Linedesk sends, as pure functions from data to subject, text and HTML (layout.ts).
// The code that decides when to send lives with its feature; these only say what the email shows.
// Names that reach an email go through emailSafeName (team.ts) or defuseLinks first: they come from
// workspaces, members or callers and must not turn into links.
//
// Every template takes the recipient's language last (`locale`, a UI language; anything else gives English): the
// frame and the labels are in it, while what callers said and the call summary stay as they were written (in the
// workspace's language). Who gets which language: docs/translations.md, "Levels".
import { isE164, type SetupStep, setupStepPath } from '@linedesk/actions'
import { getT } from '@linedesk/i18n/server'
import { emailBrandName, emailOrigin, partnerEmailBrand } from '../email-brand.ts'
import {
  type Block,
  defuseLinks,
  type EmailContent,
  escapeHtml,
  type RenderedEmail,
  renderEmail,
  siteHost,
} from './layout.ts'

/** The recipient's language: a UI language, or null/undefined for English. */
export type EmailLocale = string | null | undefined

export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

/** +15035550142 → +1 503 555 0142 (the web app's format). */
export const formatNumber = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164
}

/**
 * A name as it may appear in a email: one line, at most 60 characters, and nothing a
 * mail program would turn into a link (a workspace called "Pay at evil.example" could otherwise
 * phish the invitee). URL-like names are left out and the fallback is used.
 */
export function emailSafeName(name: string | null | undefined, fallback: string): string {
  const oneLine = (name ?? '').replace(/\s+/g, ' ').trim()
  const urlLike = /:\/\/|www\.|@|[\p{L}\p{N}-]\.[\p{L}\p{N}-]{2,}/iu
  if (!oneLine || urlLike.test(oneLine)) return fallback
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine
}

const securityUrl = (origin: string) => `${origin}/#account/security`

/** The hash parameter that names the workspace a link is for (the web app's parseHash reads it). */
export const WORKSPACE_PARAM = 'ws'

/**
 * A link into one workspace of the web app: `<origin>/#<path>?ws=<id>`. Every email link to a workspace page
 * carries it, so someone in several workspaces (an owner of two, a partner) lands in the one the email is about;
 * the web app switches to it when they are a member, and says they have no access otherwise.
 */
export function appLink(origin: string, workspaceId: string, path: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${origin}/#${path}${separator}${WORKSPACE_PARAM}=${encodeURIComponent(workspaceId)}`
}

const callLink = (origin: string, workspaceId: string, callId: string) =>
  appLink(origin, workspaceId, `call/${encodeURIComponent(callId)}`)
const notificationsLink = (origin: string, workspaceId: string) => appLink(origin, workspaceId, 'account/notifications')

// ---------------------------------------------------------------- sign-in and account

export const SIGN_IN_CODE_MINUTES = 10

/** The muted line under every code: once, how long, and that nobody asks for it. */
const codeNote = (locale: EmailLocale) =>
  getT(locale).t('email.code.note', { minutes: SIGN_IN_CODE_MINUTES, brand: emailBrandName() })

/**
 * The code in the subject and the body. With `link` (sign-in-link.ts), a button first and the code below it, both
 * working in any browser or device. The button only opens the site the email names, which shows the address and signs
 * in only on Continue, in the browser that clicks: a mail scanner that follows the link signs nobody in.
 */
/** The texts of the code email; each in a sign-in (`email.signInCode.*`) and a sign-up (`email.signUpCode.*`) form. */
type CodeEmailPart =
  | 'button'
  | 'heading'
  | 'linkHeading'
  | 'linkPreheader'
  | 'linkText'
  | 'orCode'
  | 'preheader'
  | 'reason'
  | 'subject'
  | 'text'

export function signInCodeEmail(
  code: string,
  origin = emailOrigin(),
  locale?: EmailLocale,
  link?: string,
  options: { signUp?: boolean } = {},
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  // From the sign-up page, for an address without an account yet: "Confirm your email", not "Sign in".
  const key = options.signUp ? ('signUpCode' as const) : ('signInCode' as const)
  // i18n-dynamic: email.signInCode.*, email.signUpCode.*
  const k = (name: CodeEmailPart) => `email.${key}.${name}` as const
  const blocks: Block[] = link
    ? [
        { kind: 'text', text: t(k('linkText'), { brand, site }) },
        { kind: 'button', label: t(k('button'), { brand }), url: link },
        { kind: 'text', text: t(k('orCode'), { site }) },
      ]
    : [{ kind: 'text', text: t(k('text'), { brand, site }) }]
  return renderEmail({
    locale: lang,
    subject: t(k('subject'), { code, brand }),
    preheader: link
      ? t(k('linkPreheader'), { site, minutes: SIGN_IN_CODE_MINUTES })
      : t(k('preheader'), { site, minutes: SIGN_IN_CODE_MINUTES }),
    heading: link ? t(k('linkHeading'), { brand }) : t(k('heading')),
    blocks: [...blocks, { kind: 'code', code }, { kind: 'text', tone: 'muted', text: codeNote(locale) }],
    reason: t(k('reason'), { site }),
    origin,
  })
}

/**
 * The code that confirms a signed-in member's own address. `site` is the address people open (as for
 * passkeys), so a code someone asks for elsewhere stands out.
 */
export function confirmationCodeEmail(
  code: string,
  site: string,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.confirmationCode.subject', { code, brand }),
    preheader: t('email.confirmationCode.preheader', { brand, site }),
    heading: t('email.confirmationCode.heading'),
    blocks: [
      { kind: 'text', text: t('email.confirmationCode.text', { brand, site }) },
      { kind: 'code', code },
      { kind: 'text', tone: 'muted', text: t('email.confirmationCode.note', { minutes: SIGN_IN_CODE_MINUTES, brand }) },
    ],
    reason: t('email.confirmationCode.reason'),
    origin,
  })
}

/**
 * The code that sets a new password ("Forgot password?" on the sign-in page). Like the sign-in code:
 * the code in the subject and the body, and no link.
 */
export function passwordResetCodeEmail(code: string, origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.passwordReset.subject', { code, brand }),
    preheader: t('email.passwordReset.preheader', { site, minutes: SIGN_IN_CODE_MINUTES }),
    heading: t('email.passwordReset.heading'),
    blocks: [
      { kind: 'text', text: t('email.passwordReset.text', { brand, site }) },
      { kind: 'code', code },
      { kind: 'text', tone: 'muted', text: codeNote(locale) },
    ],
    reason: t('email.passwordReset.reason', { site }),
    origin,
  })
}

export type InvitationEmail = { inviter: string; workspace: string; email: string; url: string; days: number }

/** `inviter` and `workspace` are already email-safe (emailSafeName). */
export function invitationEmail(
  { inviter, workspace, email, url, days }: InvitationEmail,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  const site = siteHost(origin)
  return renderEmail({
    locale: lang,
    subject: t('email.invitation.subject', { workspace, brand }),
    preheader: t('email.invitation.preheader', { inviter, days }),
    heading: t('email.invitation.subject', { workspace, brand }),
    blocks: [
      { kind: 'text', text: t('email.invitation.text', { inviter, workspace, brand, site }) },
      { kind: 'button', label: t('email.invitation.button'), url },
      { kind: 'text', tone: 'muted', text: t('email.invitation.note', { days, email }) },
    ],
    reason: t('email.invitation.reason'),
    origin,
  })
}

/** `inviter` and `partner` are already email-safe (emailSafeName). `role`: owner (an instance admin invited) or admin. */
export type PartnerInvitationEmail = {
  inviter: string
  partner: string
  email: string
  url: string
  days: number
  role: 'owner' | 'admin'
}

/**
 * An invitation to a white-label partner's team (docs/white-label.md): the partner's first owner (invited by an
 * instance admin when the partner was made) or an admin the owner invited. The link opens the app, which asks the
 * person to sign in with this address and then to join.
 */
export function partnerInvitationEmail(
  { inviter, partner, email, url, days, role }: PartnerInvitationEmail,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  const site = siteHost(origin)
  return renderEmail({
    locale: lang,
    subject: t('email.partnerInvitation.subject', { partner, brand }),
    preheader: t('email.partnerInvitation.preheader', { inviter, days }),
    heading: t('email.partnerInvitation.subject', { partner, brand }),
    blocks: [
      {
        kind: 'text',
        text:
          role === 'owner'
            ? t('email.partnerInvitation.textOwner', { inviter, partner, brand, site })
            : t('email.partnerInvitation.textAdmin', { inviter, partner, brand, site }),
      },
      { kind: 'button', label: t('email.partnerInvitation.button'), url },
      { kind: 'text', tone: 'muted', text: t('email.partnerInvitation.note', { days, email }) },
    ],
    reason: t('email.partnerInvitation.reason'),
    origin,
  })
}

export type OutsideConfirmEmail = {
  /** Email-safe (emailSafeName). */
  inviter: string
  workspace: string
  email: string
  url: string
  days: number
  /** The address's stop link ("Don't email me again"); null without SECRETS_KEY. */
  stopUrl: string | null
}

/**
 * An owner or admin named an address outside the team for call emails (emailRecipient.add): it gets call emails
 * only after it confirms with this link. Says what it would get (the summary and the full transcript), and has the
 * stop link, so the person can say no for good.
 */
export function outsideConfirmEmail(
  { inviter, workspace, email, url, days, stopUrl }: OutsideConfirmEmail,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  return renderEmail({
    locale: lang,
    subject: t('email.outsideConfirm.subject', { workspace }),
    preheader: t('email.outsideConfirm.preheader', { inviter, workspace }),
    heading: t('email.outsideConfirm.subject', { workspace }),
    blocks: [
      { kind: 'text', text: t('email.outsideConfirm.text', { inviter, workspace }) },
      { kind: 'button', label: t('email.outsideConfirm.button'), url },
      { kind: 'text', tone: 'muted', text: t('email.outsideConfirm.note', { days }) },
    ],
    reason: t('email.outsideConfirm.reason', { workspace, email }),
    ...(stopUrl ? { settings: { label: t('email.outsideConfirm.stop'), url: stopUrl } } : {}),
    origin,
  })
}

/** "the owner", "an admin", "a member", in a sentence. */
const roleInSentence = (role: string, locale: EmailLocale) =>
  getT(locale).t('email.role.inSentence', { role: role === 'owner' || role === 'admin' ? role : 'member' })

/**
 * A server admin added this address to a workspace (Server admin › Users › Add user, `user.invite`): the one email they
 * get, instead of the plain invitation and the welcome email. The link is the invitation's: they sign in with this
 * address (a code proves it) and join. `inviter` and `workspace` are already email-safe.
 */
export function addedToWorkspaceEmail(
  { inviter, workspace, email, url, days, role }: InvitationEmail & { role: string },
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const as = roleInSentence(role, locale)
  return renderEmail({
    locale: lang,
    subject: t('email.added.subject', { workspace, site }),
    preheader: t('email.addedToWorkspace.preheader', { inviter, role: as }),
    heading: t('email.added.heading', { workspace }),
    blocks: [
      { kind: 'text', text: t('email.added.text', { who: inviter, workspace, site, role: as }) },
      { kind: 'facts', rows: [[t('email.signInWith'), email]] },
      { kind: 'button', label: t('email.addedToWorkspace.button', { workspace }), url },
      { kind: 'text', tone: 'muted', text: t('email.addedToWorkspace.note', { days }) },
    ],
    reason: t('email.added.reason', { site }),
    origin,
  })
}

/**
 * To someone a server admin added to a workspace directly (their address was confirmed already, so there is no
 * invitation to accept). `admin` and `workspace` are already email-safe.
 */
export function addedNoticeEmail(
  { admin, workspace, workspaceId, role }: { admin: string; workspace: string; workspaceId: string; role: string },
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const as = roleInSentence(role, locale)
  return renderEmail({
    locale: lang,
    subject: t('email.added.subject', { workspace, site }),
    preheader: t('email.addedNotice.preheader', { admin, role: as }),
    heading: t('email.added.heading', { workspace }),
    blocks: [
      { kind: 'text', text: t('email.addedNotice.text', { admin, workspace, site, role: as }) },
      {
        kind: 'button',
        label: t('email.addedNotice.button', { workspace }),
        url: appLink(origin, workspaceId, 'calls'),
      },
    ],
    reason: t('email.addedNotice.reason', { site }),
    origin,
  })
}

/**
 * To a workspace's owner when a server admin adds someone to it or invites them (Server admin, membership.add,
 * user.invite): a change to who can see the workspace that its owner did not make. `pending`: an invitation, the
 * person joins once their address is confirmed. All names already email-safe.
 */
export function memberAddedByAdminEmail(
  {
    admin,
    who,
    workspace,
    workspaceId,
    role,
    pending,
  }: { admin: string; who: string; workspace: string; workspaceId: string; role: string; pending: boolean },
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const text = t('email.memberAdded.text', { admin, who, workspace, role: roleInSentence(role, locale) })
  return renderEmail({
    locale: lang,
    subject: t('email.memberAdded.subject', { admin, who, workspace }),
    preheader: text,
    eyebrow: t('email.memberAdded.eyebrow'),
    heading: t('email.memberAdded.heading', { who, workspace }),
    blocks: [
      { kind: 'text', text: pending ? `${text} ${t('email.memberAdded.pending')}` : text },
      { kind: 'text', text: t('email.memberAdded.check') },
      { kind: 'button', label: t('email.memberAdded.button'), url: appLink(origin, workspaceId, 'workspace/team') },
    ],
    reason: t('email.memberAdded.reason', { workspace, site: siteHost(origin) }),
    origin,
  })
}

/**
 * "November 14, 2026 at 9:05 AM PST" in the reader's language and the workspace's zone (UTC when unknown). Date and
 * time are formatted apart and joined by the catalog (email.dateAtTime): how ICU joins them in one format changes
 * between Node releases (Spanish "2026, 9:05" or "2026 a las 9:05"), the email must not.
 */
export function deletedWhen(at: string, timeZone: string | null | undefined, locale?: EmailLocale): string {
  const { t, format } = getT(locale)
  const write = (zone: string) => {
    const date = new Date(at)
    return t('email.dateAtTime', {
      date: format.dateTime(date, { month: 'long', day: 'numeric', year: 'numeric', timeZone: zone }),
      time: format.dateTime(date, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: zone }),
    })
  }
  try {
    return write(timeZone || 'UTC')
  } catch {
    return write('UTC')
  }
}

/**
 * To every other member when a workspace is deleted (workspace.deleteOwn, workspace.delete), and with `removed` to
 * someone whose account a removal deleted. `workspace` and `by` are already email-safe, null when there is no usable
 * name (then `byRole` says who in words). `at` and `timeZone`: when, shown in the workspace's zone in the reader's
 * language. `accountDeleted`: their account went with it (no other workspace). Sent from a job (jobs.ts).
 */
export type WorkspaceDeletedEmail = {
  workspace: string | null
  by: string | null
  /** Who did it when `by` is null: the server admin of the install, the owner, or a workspace admin. */
  byRole?: 'serverAdmin' | 'owner' | 'admin'
  at?: string
  timeZone?: string | null
  /** Jobs queued by an older release: the time already formatted, in English. */
  when?: string
  accountDeleted: boolean
  /**
   * They were removed from the workspace, which stays (team.removeMember by the owner, membership.remove; LIN-264).
   * Absent in jobs queued by an older release: a delete.
   */
  removed?: boolean
}

export function workspaceDeletedEmail(
  content: WorkspaceDeletedEmail,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { accountDeleted, removed = false } = content
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  const workspace = content.workspace || t('email.fallback.yourWorkspace')
  const by =
    content.by ||
    (content.byRole === 'serverAdmin'
      ? t('email.workspaceDeleted.byServerAdmin', { site })
      : content.byRole === 'owner'
        ? t('email.fallback.owner')
        : t('email.fallback.workspaceAdmin'))
  const when = content.at ? deletedWhen(content.at, content.timeZone, locale) : (content.when ?? '')
  return renderEmail({
    locale: lang,
    subject: removed
      ? t('email.workspaceRemoved.subject', { workspace, brand })
      : t('email.workspaceDeleted.subject', { workspace, brand }),
    preheader: removed
      ? t('email.workspaceRemoved.preheader', { by, when })
      : t('email.workspaceDeleted.preheader', { by, when }),
    eyebrow: t('email.eyebrow.account'),
    heading: removed
      ? t('email.workspaceRemoved.heading', { workspace })
      : t('email.workspaceDeleted.heading', { workspace }),
    blocks: [
      {
        kind: 'text',
        text: removed
          ? t('email.workspaceRemoved.text', { by, workspace, when })
          : t('email.workspaceDeleted.text', { by, workspace, when }),
      },
      accountDeleted
        ? {
            kind: 'text',
            text: removed
              ? t('email.workspaceRemoved.accountDeleted', { brand, site })
              : t('email.workspaceDeleted.accountDeleted', { brand, site }),
          }
        : { kind: 'text', text: t('email.workspaceDeleted.accountKept') },
      ...(accountDeleted ? [] : [{ kind: 'button' as const, label: t('email.open', { name: brand }), url: origin }]),
      {
        kind: 'text',
        tone: 'muted',
        text: removed ? t('email.workspaceRemoved.unexpected') : t('email.workspaceDeleted.unexpected'),
      },
    ],
    reason: t('email.workspaceDeleted.reason', { workspace, site }),
    origin,
  })
}

/** No code in it: codes expire in 10 minutes, a welcome may be read later. The sign-in page sends one. */
export function welcomeEmail(
  { name, email }: { name: string | null; email: string },
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.welcome.subject', { brand }),
    preheader: t('email.welcome.preheader', { site }),
    heading: name ? t('email.welcome.heading', { name }) : t('email.welcome.headingNoName'),
    blocks: [
      { kind: 'text', text: t('email.welcome.text', { brand, site }) },
      { kind: 'facts', rows: [[t('email.signInWith'), email]] },
      { kind: 'button', label: t('email.signIn'), url: origin },
      { kind: 'text', tone: 'muted', text: t('email.enterAddress') },
    ],
    reason: t('email.welcome.reason', { site }),
    origin,
  })
}

// ---------------------------------------------------------------- security notices

export function passkeyChangedEmail(
  change: 'added' | 'removed',
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.passkeyChanged.subject', { change, brand }),
    preheader: t('email.security.nothingToDo'),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.passkeyChanged.heading', { change }),
    blocks: [
      {
        kind: 'text',
        text: `${t('email.passkeyChanged.text', { change, brand, site: siteHost(origin) })} ${t('email.security.nothingToDo')}`,
      },
      { kind: 'text', text: t('email.passkeyChanged.notYou', { brand }) },
      { kind: 'button', label: t('email.security.review'), url: securityUrl(origin) },
    ],
    reason: t('email.security.reason'),
    origin,
  })
}

/** A personal API key was made for the account (personal-keys.ts; LIN-339 security review M2). */
export function personalKeyCreatedEmail(
  name: string,
  prefix: string,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.personalKeyCreated.subject', { brand }),
    preheader: t('email.security.nothingToDo'),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.personalKeyCreated.heading'),
    blocks: [
      {
        kind: 'text',
        text: `${t('email.personalKeyCreated.text', { name: emailSafeName(name, '-'), prefix, brand, site: siteHost(origin) })} ${t('email.security.nothingToDo')}`,
      },
      { kind: 'text', text: t('email.personalKeyCreated.notYou') },
      { kind: 'button', label: t('email.personalKeyCreated.review'), url: `${origin}/#account/apiKeys` },
    ],
    reason: t('email.personalKeyCreated.reason'),
    origin,
  })
}

/** An instance admin's authenticator app was added or removed (authenticator.ts). */
export function authenticatorChangedEmail(
  change: 'added' | 'removed',
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.authenticatorChanged.subject', { change, brand }),
    preheader: t('email.security.nothingToDo'),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.authenticatorChanged.heading', { change }),
    blocks: [
      {
        kind: 'text',
        text: `${t('email.authenticatorChanged.text', { change, brand, site: siteHost(origin) })} ${t('email.security.nothingToDo')}`,
      },
      { kind: 'text', text: t('email.authenticatorChanged.notYou', { brand }) },
      { kind: 'button', label: t('email.security.review'), url: securityUrl(origin) },
    ],
    reason: t('email.security.reason'),
    origin,
  })
}

/** After a password reset by emailed code: every session of the account was ended. */
export function passwordChangedEmail(origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.passwordChanged.subject', { brand }),
    preheader: t('email.security.nothingToDo'),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.passwordChanged.heading'),
    blocks: [
      {
        kind: 'text',
        text: `${t('email.passwordChanged.text', { brand, site: siteHost(origin) })} ${t('email.security.nothingToDo')}`,
      },
      { kind: 'text', text: t('email.passwordChanged.notYou') },
      { kind: 'button', label: t('email.security.review'), url: securityUrl(origin) },
    ],
    reason: t('email.security.reason'),
    origin,
  })
}

/**
 * The code that moves an account to a new address (Account settings › Profile › Change), sent to the
 * new address: proving it is the change. Like the other codes: in the subject and the body, no link.
 */
export function emailChangeCodeEmail(code: string, origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.emailChangeCode.subject', { code, brand }),
    preheader: t('email.emailChangeCode.preheader', { site }),
    heading: t('email.emailChangeCode.heading'),
    blocks: [
      { kind: 'text', text: t('email.emailChangeCode.text', { site, brand }) },
      { kind: 'code', code },
      { kind: 'text', tone: 'muted', text: codeNote(locale) },
    ],
    reason: t('email.emailChangeCode.reason', { brand, site }),
    origin,
  })
}

/**
 * The first step of an email change in a session without a recent passkey sign-in: a code to the
 * current address proves the person asking still has it, so a stolen password alone can't move the
 * account. No link, as the other codes.
 */
export function emailChangeConfirmCurrentEmail(
  code: string,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.emailChangeConfirm.subject', { code, brand }),
    preheader: t('email.emailChangeConfirm.preheader', { site }),
    heading: t('email.emailChangeConfirm.heading'),
    blocks: [
      { kind: 'text', text: t('email.emailChangeConfirm.text', { brand, site }) },
      { kind: 'code', code },
      { kind: 'text', tone: 'muted', text: codeNote(locale) },
    ],
    reason: t('email.emailChangeConfirm.reason'),
    origin,
  })
}

/**
 * Sent instead of the code when the new address already has an account (or is reserved for a
 * server admin): only the mailbox's owner learns that it cannot be used, never the person asking.
 */
export function emailChangeRefusedEmail(origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.emailChangeRefused.subject', { brand }),
    preheader: t('email.emailChangeRefused.preheader'),
    heading: t('email.emailChangeRefused.heading'),
    blocks: [
      { kind: 'text', text: t('email.emailChangeRefused.text', { brand, site }) },
      { kind: 'text', tone: 'muted', text: t('email.emailChangeRefused.note') },
    ],
    reason: t('email.emailChangeRefused.reason'),
    origin,
  })
}

/** To the old address once an account moved to a new one: the only place the real owner can still be told. */
export function emailChangedEmail(newEmail: string, origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = emailBrandName()
  const shown = defuseLinks(newEmail)
  return renderEmail({
    locale: lang,
    subject: t('email.emailChanged.subject', { brand }),
    preheader: t('email.emailChanged.preheader', { email: shown }),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.emailChanged.heading'),
    blocks: [
      {
        kind: 'text',
        text: `${t('email.emailChanged.text', { brand, site, email: shown })} ${t('email.security.nothingToDo')}`,
      },
      { kind: 'text', text: t('email.emailChanged.notYou') },
    ],
    reason: t('email.emailChanged.reason'),
    origin,
  })
}

/** When a server admin resets someone's passkeys (also with none to remove, for a server admin). */
export function passkeysResetEmail(removed: number, origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  const kind = removed > 0 ? 'removed' : 'issued'
  return renderEmail({
    locale: lang,
    subject: t('email.passkeysReset.subject', { kind, brand }),
    preheader: t('email.passkeysReset.preheader'),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.passkeysReset.heading', { kind }),
    blocks: [
      { kind: 'text', text: t('email.passkeysReset.text', { kind, brand }) },
      { kind: 'text', text: t('email.passkeysReset.next') },
      { kind: 'button', label: t('email.signIn'), url: origin },
      { kind: 'text', tone: 'muted', text: t('email.passkeysReset.unexpected') },
    ],
    reason: t('email.security.reason'),
    origin,
  })
}

/**
 * A server admin issued the code for the first passkey of a server admin who has none (user.issuePasskeyEnrolment):
 * nothing was removed and nobody was signed out. `issuedBy`: the admin's address, or the server operator.
 */
export function passkeyEnrolmentIssuedEmail(
  issuedBy: string,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.passkeysReset.subject', { kind: 'issued', brand }),
    preheader: t('email.passkeyEnrolment.preheader'),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.passkeysReset.heading', { kind: 'issued' }),
    blocks: [
      { kind: 'text', text: t('email.passkeyEnrolment.text', { issuedBy, brand }) },
      { kind: 'text', text: t('email.passkeyEnrolment.next') },
      { kind: 'button', label: t('email.passkeyEnrolment.button'), url: `${origin}/#account/security` },
      { kind: 'text', tone: 'muted', text: t('email.passkeyEnrolment.unexpected', { brand }) },
    ],
    reason: t('email.security.reason'),
    origin,
  })
}

// ---------------------------------------------------------------- calls

/** A booked slot for an email read anywhere, with the zone's short name: "Tuesday, November 17 at 9:00 AM PST". */
export const slotInZone = (at: Date | string, timeZone: string, locale?: EmailLocale) =>
  getT(locale).format.dateTime(new Date(at), {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })

export type CallEmail = {
  /** The call's workspace: its links open there. */
  workspaceId: string
  callId: string
  title: string | null
  summary: string | null
  urgent: boolean
  fromNumber: string
  callerName: string | null
  assistantName: string
  startedAt: Date | string
  durationSec: number | null
  timeZone: string
  nextSteps: string[]
  /** What the summary pulled out of the call (the app's "Key facts"), as label and value. */
  fields: { label: string; value: string }[]
  /** The appointment booked on the call, when there is one. */
  booking: { what: string; when: string } | null
  /** What was said, in order: the caller, the assistant and team members who took over (no tool or system lines). */
  transcript: { speaker: 'caller' | 'agent' | 'human'; text: string }[]
  /** Email-safe (emailSafeName). */
  workspace: string
}

/**
 * The transcript's length in an email, in characters: about a 20-minute call. Gmail clips an email's HTML
 * above 102 KB behind "View entire message"; the rest of a longer call is in the app.
 */
export const EMAIL_TRANSCRIPT_MAX_CHARS = 15_000

/** The transcript's lines, speaker first, cut at EMAIL_TRANSCRIPT_MAX_CHARS; `cut` when lines were left out. */
function transcriptLines(call: CallEmail, callerName: string | null, locale: EmailLocale) {
  const { t } = getT(locale)
  const names = {
    caller: callerName ?? t('email.call.caller'),
    agent: call.assistantName,
    human: t('email.call.team'),
  }
  const lines: [string, string][] = []
  let chars = 0
  for (const { speaker, text } of call.transcript) {
    const said = text.trim()
    if (!said) continue
    if (chars + said.length > EMAIL_TRANSCRIPT_MAX_CHARS && lines.length) return { lines, cut: true }
    chars += said.length
    lines.push([names[speaker], defuseLinks(said)])
  }
  return { lines, cut: false }
}

/**
 * A call email to an address outside the team (email routing, email_recipients): no link into the app, which it
 * cannot open, and a footer that says why it gets the email, with its one-click link to stop them.
 */
export type OutsideCallEmail = { stopUrl: string }

/** One finished call: what it was about, who called, the summary, next steps, the booking and a link. */
export const callEmail = (
  call: CallEmail,
  origin = emailOrigin(),
  locale?: EmailLocale,
  outside?: OutsideCallEmail,
): RenderedEmail => renderEmail(callContent(call, origin, locale, outside))

/** The caller and number rows every call email starts with. */
const callerFacts = (callerName: string | null, number: string, locale: EmailLocale): Block => {
  const { t } = getT(locale)
  return {
    kind: 'facts',
    rows: [
      [t('email.call.caller'), callerName ?? t('email.call.unknownCaller')],
      [t('email.call.number'), number],
    ],
  }
}

function callContent(call: CallEmail, origin: string, locale: EmailLocale, outside?: OutsideCallEmail): EmailContent {
  const { t, format, locale: lang } = getT(locale)
  const number = formatNumber(call.fromNumber)
  const callerName = call.callerName ? defuseLinks(call.callerName) : null
  const topic = call.title ? defuseLinks(call.title) : t('email.call.newCall')
  const at = format
    .dateTime(new Date(call.startedAt), {
      timeZone: call.timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/\s/g, ' ') // plain spaces: some mail apps show the narrow one as a box
  const eyebrow = [
    t('email.call.answeredBy', { assistant: call.assistantName }),
    at,
    call.durationSec ? t('email.call.minutes', { count: Math.max(1, Math.round(call.durationSec / 60)) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const blocks: Block[] = [callerFacts(callerName, number, locale)]
  if (call.summary) blocks.push({ kind: 'text', text: defuseLinks(call.summary) })
  const fields = call.fields.filter(f => f.label.trim() && f.value.trim())
  if (fields.length)
    blocks.push({
      kind: 'facts',
      title: t('email.call.keyFacts'),
      rows: fields.map(f => [defuseLinks(f.label.trim()), defuseLinks(f.value.trim())]),
    })
  if (call.nextSteps.length)
    blocks.push({ kind: 'list', title: t('email.call.nextSteps'), items: call.nextSteps.map(defuseLinks) })
  if (call.booking) {
    blocks.push({
      kind: 'facts',
      title: t('email.call.booked'),
      rows: [
        [t('email.call.what'), defuseLinks(call.booking.what)],
        [t('email.call.when'), call.booking.when],
      ],
    })
  }
  // The button before the transcript: a long call would push it far down. Outside the team: no app to open.
  if (!outside)
    blocks.push({
      kind: 'button',
      label: t('email.call.open'),
      url: callLink(origin, call.workspaceId, call.callId),
      // No caller ID ("anonymous"): nothing to dial.
      call: isE164(call.fromNumber) ? { label: t('email.call.callBack'), number: call.fromNumber } : undefined,
    })
  const transcript = transcriptLines(call, callerName, locale)
  if (transcript.lines.length) {
    blocks.push({ kind: 'transcript', title: t('email.call.transcript'), lines: transcript.lines })
    if (transcript.cut) blocks.push({ kind: 'text', tone: 'muted', text: t('email.call.transcriptCut') })
  }
  if (!outside)
    blocks.push({
      kind: 'text',
      tone: 'muted',
      text: transcript.lines.length
        ? t('email.call.recordingOnly', { brand: emailBrandName() })
        : t('email.call.recording', { brand: emailBrandName() }),
    })
  const from = callerName ?? number
  return {
    locale: lang,
    subject: call.urgent ? t('email.call.subjectUrgent', { topic, from }) : t('email.call.subject', { topic, from }),
    preheader: call.summary
      ? defuseLinks(call.summary).slice(0, 140)
      : t('email.call.preheader', { assistant: call.assistantName, from }),
    eyebrow,
    urgent: call.urgent ? t('email.call.urgent') : undefined,
    heading: topic,
    blocks,
    reason: outside
      ? t('email.call.outsideReason', { workspace: call.workspace })
      : t('email.call.reason', { workspace: call.workspace }),
    settings: outside
      ? { label: t('email.call.outsideStop'), url: outside.stopUrl }
      : { label: t('email.notificationSettings'), url: notificationsLink(origin, call.workspaceId) },
    origin,
  }
}

export type AssignedCallEmail = {
  /** The call's workspace: its links open there. */
  workspaceId: string
  callId: string
  title: string | null
  summary: string | null
  urgent: boolean
  fromNumber: string
  callerName: string | null
  /** Who assigned it; email-safe (emailSafeName). */
  assignedBy: string
  /** Email-safe (emailSafeName). */
  workspace: string
}

/** A teammate assigned the recipient a call: who did, the caller, the summary and a link. */
export function assignedCallEmail(a: AssignedCallEmail, origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const number = formatNumber(a.fromNumber)
  const callerName = a.callerName ? defuseLinks(a.callerName) : null
  const from = callerName ?? number
  const topic = a.title ? defuseLinks(a.title) : t('email.assigned.callFrom', { from })
  const blocks: Block[] = [callerFacts(callerName, number, locale)]
  if (a.summary) blocks.push({ kind: 'text', text: defuseLinks(a.summary) })
  blocks.push({ kind: 'button', label: t('email.call.open'), url: callLink(origin, a.workspaceId, a.callId) })
  return renderEmail({
    locale: lang,
    subject: t('email.assigned.subject', { by: a.assignedBy, topic }),
    preheader: t('email.assigned.preheader', { by: a.assignedBy, from }),
    eyebrow: t('email.assigned.eyebrow', { by: a.assignedBy }),
    urgent: a.urgent ? t('email.call.urgent') : undefined,
    heading: topic,
    blocks,
    reason: t('email.assigned.reason', { workspace: a.workspace }),
    settings: { label: t('email.notificationSettings'), url: notificationsLink(origin, a.workspaceId) },
    origin,
  })
}

// ---------------------------------------------------------------- to callers

export type BookingConfirmation = {
  /** Email-safe (emailSafeName). */
  business: string
  /** The appointment type, lower case ("repair visit"), in the business's own words. */
  what: string
  /** Date and time with the time zone ("Tuesday, November 17 at 9:00 AM PST"). */
  when: string
  minutes: number | null
  /** Where the appointment is, as the caller gave it. */
  address: string | null
  /** The number to call to change it: the business's own. */
  phone: string | null
}

/**
 * No link: the caller has no account. They change the booking by calling. The frame is in `locale` (the call's
 * language); the appointment type and the address stay as the business and the caller wrote them.
 */
export function bookingConfirmationEmail(
  b: BookingConfirmation,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const rows: [string, string][] = [[t('email.call.when'), b.when]]
  if (b.minutes) rows.push([t('email.booking.length'), t('email.booking.minutes', { count: b.minutes })])
  if (b.address) rows.push([t('email.booking.where'), defuseLinks(b.address)])
  const change = b.phone
    ? t('email.booking.change', { business: b.business, phone: formatNumber(b.phone) })
    : t('email.booking.changeBack', { business: b.business })
  return renderEmail({
    locale: lang,
    subject: t('email.booking.subject', { what: b.what, business: b.business, when: b.when }),
    preheader: `${b.when}. ${change}`,
    business: b.business,
    eyebrow: t('email.booking.eyebrow'),
    heading: t('email.booking.heading', { what: b.what }),
    blocks: [
      { kind: 'facts', title: b.business, rows },
      { kind: 'text', text: change },
    ],
    reason: t('email.booking.reason', { business: b.business }),
    origin,
  })
}

// ---------------------------------------------------------------- setup (setup-emails.ts)

/**
 * The partner directory (agencies that set up Linedesk for a business; hands-on help comes from them, not from calls
 * with us): PARTNER_DIRECTORY_URL, set on Linedesk Cloud. Unset (a self-hosted install), the setup emails offer no
 * partner. A malformed value fails at start, not silently.
 */
export function readPartnerDirectoryUrl(env: Record<string, string | undefined>): string | null {
  const url = env.PARTNER_DIRECTORY_URL?.trim()
  if (!url) return null
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`PARTNER_DIRECTORY_URL ${url} is not an http(s) URL`)
  return url
}

export const PARTNER_DIRECTORY_URL = readPartnerDirectoryUrl(process.env)

export type SetupEmail = {
  /** The workspace the email is about: its links open there. */
  workspaceId: string
  /** Email-safe (emailSafeName), like the assistant's name. */
  workspace: string
  assistantName: string
  /** The workspace's setup number (setupNumber, @linedesk/actions), when it has one: its id and e164. */
  numberId: string | null
  number: string | null
  /** The number takes every call (takesAllCalls: forward all, or a new number callers dial), not only the missed ones. */
  takesAllCalls: boolean
  /** The next open step (nextSetupStep), the same one the go-live checklist in the inbox shows first. */
  step: SetupStep
}

/** The button: straight to where the next step is done (setupStepPath), like the go-live checklist's row. */
const setupButton = (s: SetupEmail, origin: string, locale: EmailLocale) => ({
  kind: 'button' as const,
  label: s.step === 'first_call' ? getT(locale).t('email.setup.openInbox') : getT(locale).t('email.setup.finish'),
  url: appLink(origin, s.workspaceId, setupStepPath(s.step, s.numberId ? { id: s.numberId } : null)),
})
/** Where a setup email's footer link goes: the one-click unsubscribe link when there is one, else the signed-in setting. */
const setupSettings = (
  origin: string,
  workspaceId: string,
  unsubscribeUrl: string | null | undefined,
  locale: EmailLocale,
) => ({
  label: getT(locale).t('email.setup.turnOff'),
  url: unsubscribeUrl ?? notificationsLink(origin, workspaceId),
})
const setupFooter = (
  s: { workspaceId: string; workspace: string; assistantName: string },
  origin: string,
  unsubscribeUrl: string | null | undefined,
  locale: EmailLocale,
) => ({
  reason: getT(locale).t('email.setup.reason', { workspace: s.workspace, assistant: s.assistantName }),
  settings: setupSettings(origin, s.workspaceId, unsubscribeUrl, locale),
})

/** The one next step, plain. */
function nextStep({ assistantName: assistant, number, takesAllCalls, step }: SetupEmail, locale: EmailLocale): string {
  const { t } = getT(locale)
  const brand = emailBrandName()
  if (step === 'number') return t('email.setup.stepNumber', { assistant, brand })
  // Calls from the business's own phones are the owner trying it out and never count as real calls.
  // A teammate whose phone takes transferred calls counts as the business's own too, so: a friend's.
  if (step === 'first_call')
    return takesAllCalls ? t('email.setup.stepCallAll', { assistant }) : t('email.setup.stepCallMissed', { assistant })
  const to = number ? formatNumber(number) : t('email.setup.yourNumber', { brand })
  return takesAllCalls
    ? t('email.setup.stepForwardAll', { to, brand })
    : t('email.setup.stepForwardMissed', { to, brand })
}

/** A few hours after the owner joined, while no real call has reached the assistant yet: what is left. */
export function setupDay0Email(
  s: SetupEmail,
  origin = emailOrigin(),
  unsubscribeUrl?: string | null,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  return renderEmail({
    locale: lang,
    subject: t('email.setup.day0Subject', { assistant: s.assistantName, workspace: s.workspace }),
    preheader: nextStep(s, locale),
    heading: s.step === 'first_call' ? t('email.setup.day0HeadingCall') : t('email.setup.oneStepLeft'),
    blocks: [
      { kind: 'text', text: t('email.setup.day0Text', { assistant: s.assistantName, workspace: s.workspace }) },
      { kind: 'text', text: nextStep(s, locale) },
      setupButton(s, origin, locale),
    ],
    ...setupFooter(s, origin, unsubscribeUrl, locale),
    origin,
  })
}

/**
 * Day 1 and day 3 without a real call: the one next step; on day 3 also a partner who does it for them, when the
 * install has a partner directory (`partnerDirectory`, PARTNER_DIRECTORY_URL).
 */
export function setupNudgeEmail(
  day: 1 | 3,
  s: SetupEmail,
  origin = emailOrigin(),
  unsubscribeUrl?: string | null,
  partnerDirectory: string | null = PARTNER_DIRECTORY_URL,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const blocks: Block[] = [
    { kind: 'text', text: t('email.setup.nudgeText', { assistant: s.assistantName }) },
    { kind: 'text', text: nextStep(s, locale) },
    setupButton(s, origin, locale),
  ]
  // A white-label partner's client already has its partner: no directory of other partners (S4).
  if (day === 3 && partnerDirectory && !partnerEmailBrand()) {
    blocks.push(
      { kind: 'text', text: t('email.setup.partner', { brand: emailBrandName(), workspace: s.workspace }) },
      { kind: 'button', label: t('email.setup.findPartner'), url: partnerDirectory },
    )
  }
  return renderEmail({
    locale: lang,
    subject:
      day === 1
        ? t('email.setup.day1Subject', { assistant: s.assistantName })
        : t('email.setup.day3Subject', { assistant: s.assistantName }),
    preheader: nextStep(s, locale),
    heading: day === 1 ? t('email.setup.day1Heading') : t('email.setup.oneStepLeft'),
    blocks,
    ...setupFooter(s, origin, unsubscribeUrl, locale),
    origin,
  })
}

/** The first real call: the call email, as a moment. Sent instead of the usual one to members who get call emails. */
export function firstCallEmail(call: CallEmail, origin = emailOrigin(), locale?: EmailLocale): RenderedEmail {
  const { t } = getT(locale)
  const content = callContent(call, origin, locale)
  const callerName = call.callerName ? defuseLinks(call.callerName) : null
  const from = callerName ?? formatNumber(call.fromNumber)
  return renderEmail({
    ...content,
    subject: call.urgent ? t('email.firstCall.subjectUrgent', { from }) : t('email.firstCall.subject', { from }),
    heading: t('email.firstCall.heading'),
    blocks: [
      {
        kind: 'text',
        text: call.title
          ? t('email.firstCall.textTitle', { workspace: call.workspace, title: defuseLinks(call.title) })
          : t('email.firstCall.text', { workspace: call.workspace }),
      },
      ...content.blocks,
    ],
    reason: t('email.firstCall.reason', { workspace: call.workspace }),
  })
}

export type WeekSummaryEmail = {
  /** The workspace the email is about: its links open there. */
  workspaceId: string
  /** Email-safe (emailSafeName), like the assistant's name. */
  workspace: string
  assistantName: string
  /** Real calls since the owner joined (not tests, not the business's own phones, not spam). */
  calls: number
  urgent: number
  booked: number
  messages: number
}

/** A week after the owner joined, for a business that is live: what its assistant did. */
export function weekSummaryEmail(
  w: WeekSummaryEmail,
  origin = emailOrigin(),
  unsubscribeUrl?: string | null,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const values = { assistant: w.assistantName, workspace: w.workspace, count: w.calls }
  return renderEmail({
    locale: lang,
    subject: t('email.week.subject', values),
    preheader: t('email.week.preheader', values),
    heading: t('email.week.heading'),
    blocks: [
      { kind: 'text', text: t('email.week.text', values) },
      {
        kind: 'facts',
        rows: [
          [t('email.week.calls'), format.number(w.calls)],
          [t('email.week.urgent'), format.number(w.urgent)],
          [t('email.week.booked'), format.number(w.booked)],
          [t('email.week.messages'), format.number(w.messages)],
        ],
      },
      { kind: 'button', label: t('email.week.button'), url: appLink(origin, w.workspaceId, 'calls') },
    ],
    reason: t('email.week.reason', { workspace: w.workspace }),
    settings: setupSettings(origin, w.workspaceId, unsubscribeUrl, locale),
    origin,
  })
}

// ---------------------------------------------------------------- founder email (founder-email.ts)

/** The first name to greet: the first word of the account's name, when it looks like a name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  if (!first || first.length > 40 || /[@<>{}\d]/.test(first)) return null
  return first
}

/** Who the founder email comes from (founder-email.ts). */
export type FounderSender = { name: string; email: string }

export type FounderEmail = {
  /** The owner's first name, or null ("Hey there,"). */
  firstName: string | null
  founder: FounderSender
  /** The one-click unsubscribe link (setup-unsubscribe.ts), else the signed-in notification settings. */
  unsubscribeUrl: string
}

/**
 * The email itself, as a person writes it: no layout, no styles. The HTML part is the same text with "Unsubscribe" as a
 * word link (the long one-click URL shows only in the text part, for mail apps without HTML).
 */
export function founderEmail(e: FounderEmail, locale?: EmailLocale): { subject: string; text: string; html: string } {
  const { t } = getT(locale)
  const founder = firstNameOf(e.founder.name) ?? e.founder.name
  const greeting = e.firstName ? t('email.founder.greeting', { name: e.firstName }) : t('email.founder.greetingNoName')
  const body = t('email.founder.body', { founder, brand: emailBrandName() })
  const unsubscribe = t('email.founder.unsubscribe', { url: e.unsubscribeUrl })
  const paragraphs = `${greeting}\n\n${body}`
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
  const link = `<p><a href="${escapeHtml(e.unsubscribeUrl)}">${escapeHtml(t('email.founder.unsubscribeLink'))}</a></p>`
  return {
    subject: t('email.founder.subject'),
    text: `${greeting}\n\n${body}\n\n${unsubscribe}\n`,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body><div dir="ltr">${paragraphs}${link}</div></body></html>`,
  }
}
