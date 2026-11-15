// Every email Linedesk sends, as pure functions from data to subject, text and HTML (layout.ts).
// The code that decides when to send lives with its feature; these only say what the email shows.
// Names that reach an email go through emailSafeName (team.ts) or defuseLinks first: they come from
// workspaces, members or callers and must not turn into links.
//
// Every template takes the recipient's language last (`locale`, a UI language; anything else gives English): the
// frame and the labels are in it, while what callers said and the call summary stay as they were written (in the
// workspace's language). Who gets which language: docs/translations.md, "Levels".
import { type SetupStep, setupStepPath } from '@linedesk/actions'
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import { type Block, defuseLinks, type EmailContent, type RenderedEmail, renderEmail, siteHost } from './layout.ts'

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
  getT(locale).t('email.code.note', { minutes: SIGN_IN_CODE_MINUTES, brand: brandName() })

/** The code in the subject and the body, and no link: a link in a code email teaches people to click them. */
export function signInCodeEmail(code: string, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
  return renderEmail({
    locale: lang,
    subject: t('email.signInCode.subject', { code, brand }),
    preheader: t('email.signInCode.preheader', { site, minutes: SIGN_IN_CODE_MINUTES }),
    heading: t('email.signInCode.heading'),
    blocks: [
      { kind: 'text', text: t('email.signInCode.text', { brand, site }) },
      { kind: 'code', code },
      { kind: 'text', tone: 'muted', text: codeNote(locale) },
    ],
    reason: t('email.signInCode.reason', { site }),
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
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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
export function passwordResetCodeEmail(code: string, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
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
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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
  origin = WEB_ORIGIN,
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
  origin = WEB_ORIGIN,
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
  origin = WEB_ORIGIN,
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
 * To every other member when a workspace is deleted (workspace.deleteOwn, workspace.delete), and with `removed` to
 * someone whose account a removal deleted. `workspace` and `by` are already email-safe; `when` is formatted in the
 * workspace's time zone. `accountDeleted`: their account went with it (no other workspace).
 */
export type WorkspaceDeletedEmail = {
  workspace: string
  by: string
  when: string
  accountDeleted: boolean
  /**
   * They were removed from the workspace, which stays (team.removeMember by the owner, membership.remove; LIN-264).
   * Absent in jobs queued by an older release: a delete.
   */
  removed?: boolean
}

export function workspaceDeletedEmail(
  { workspace, by, when, accountDeleted, removed = false }: WorkspaceDeletedEmail,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
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
  { name, email }: { name: string; email: string },
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
  return renderEmail({
    locale: lang,
    subject: t('email.welcome.subject', { brand }),
    preheader: t('email.welcome.preheader', { site }),
    heading: t('email.welcome.heading', { name }),
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
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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

/** An instance admin's authenticator app was added or removed (authenticator.ts). */
export function authenticatorChangedEmail(
  change: 'added' | 'removed',
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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
export function passwordChangedEmail(origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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
export function emailChangeCodeEmail(code: string, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
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
export function emailChangeConfirmCurrentEmail(code: string, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
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
export function emailChangeRefusedEmail(origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
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
export function emailChangedEmail(newEmail: string, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const site = siteHost(origin)
  const brand = brandName()
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
export function passkeysResetEmail(removed: number, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = brandName()
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

/** What the email to a user says when an instance admin signed in as them (impersonation.ts). */
export type ImpersonationStartedEmail = {
  admin: { name: string; email: string }
  /** As the admin typed it: shown as plain text, links defused. */
  reason: string
  /** ISO time it started. */
  at: string
  /** The workspace it opened in, null without one. */
  workspace: string | null
  minutes: number
}

/**
 * When an instance admin signs in as a user, and the install turned these emails on (impersonationEmails.set): who,
 * why, when (UTC) and in which workspace. The admin's name and the reason are theirs to write: no links come of them.
 */
export function impersonationStartedEmail(
  { admin, reason, at, workspace, minutes }: ImpersonationStartedEmail,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang, format } = getT(locale)
  const brand = brandName()
  const site = siteHost(origin)
  const by = emailSafeName(admin.name, defuseLinks(admin.email))
  const when = `${format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
  const ws = workspace ? emailSafeName(workspace, '') : ''
  return renderEmail({
    locale: lang,
    subject: t('email.impersonationStarted.subject', { brand }),
    preheader: t('email.impersonationStarted.preheader', { by, when }),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.impersonationStarted.heading'),
    blocks: [
      {
        kind: 'text',
        text: t('email.impersonationStarted.text', { by, when, site, brand, workspace: ws, hasWorkspace: ws ? 'yes' : 'no' }),
      },
      { kind: 'text', text: t('email.impersonationStarted.reason', { reason: defuseLinks(reason.replace(/\s+/g, ' ').trim()) }) },
      { kind: 'text', text: t('email.impersonationStarted.limits', { minutes }) },
      { kind: 'text', tone: 'muted', text: t('email.impersonationStarted.unexpected') },
    ],
    reason: t('email.impersonationStarted.why', { site }),
    origin,
  })
}

/** What the email to a user says when an instance admin made an API key while signed in as them (impersonation-emails.ts). */
export type ImpersonationApiKeyEmail = {
  admin: { name: string; email: string }
  /** The key's name, as the admin typed it: shown as plain text, links defused. */
  keyName: string
  /** The start of the key, as Workspace settings › Developers shows it. */
  prefix: string
  /** The key's role: what it may do. */
  role: 'member' | 'admin'
  /** ISO time it was made. */
  at: string
  /** The workspace the key is for. */
  workspace: string | null
}

/**
 * When an instance admin made an API key while signed in as a user, and the install turned impersonation emails on: which
 * admin, which key, when (UTC) and where to revoke it. A key outlasts the support access, so the user hears of it.
 */
export function impersonationApiKeyEmail(
  { admin, keyName, prefix, role, at, workspace }: ImpersonationApiKeyEmail,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang, format } = getT(locale)
  const brand = brandName()
  const site = siteHost(origin)
  const by = emailSafeName(admin.name, defuseLinks(admin.email))
  const when = `${format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
  const ws = workspace ? emailSafeName(workspace, '') : ''
  const name = defuseLinks(keyName.replace(/\s+/g, ' ').trim())
  return renderEmail({
    locale: lang,
    subject: t('email.impersonationApiKey.subject', { brand }),
    preheader: t('email.impersonationApiKey.preheader', { by, when }),
    eyebrow: t('email.eyebrow.security'),
    heading: t('email.impersonationApiKey.heading'),
    blocks: [
      {
        kind: 'text',
        text: t('email.impersonationApiKey.text', { by, when, site, workspace: ws, hasWorkspace: ws ? 'yes' : 'no' }),
      },
      { kind: 'text', text: t('email.impersonationApiKey.key', { name, prefix: `${prefix}…`, role }) },
      { kind: 'text', text: t('email.impersonationApiKey.limits') },
      { kind: 'text', tone: 'muted', text: t('email.impersonationApiKey.unexpected') },
    ],
    reason: t('email.impersonationStarted.why', { site }),
    origin,
  })
}

/**
 * An alert to every server admin (admin-alerts.ts). `text` is already plain and link-free; blank lines split
 * paragraphs. The subject and text come from the alert itself (English); the frame is in the recipient's language.
 */
export function adminAlertEmail(
  subject: string,
  text: string,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
  return renderEmail({
    locale: lang,
    subject,
    preheader: paragraphs[0] ?? subject,
    eyebrow: t('email.adminAlert.eyebrow'),
    heading: subject,
    blocks: [
      ...paragraphs.map(p => ({ kind: 'text', text: p }) as const),
      { kind: 'button', label: t('email.adminAlert.button'), url: `${origin}/#admin/audit` },
    ],
    reason: t('email.adminAlert.reason', { site: siteHost(origin) }),
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
  /** The appointment booked on the call, when there is one. */
  booking: { what: string; when: string } | null
  /** Email-safe (emailSafeName). */
  workspace: string
}

/** One finished call: what it was about, who called, the summary, next steps, the booking and a link. */
export const callEmail = (call: CallEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail =>
  renderEmail(callContent(call, origin, locale))

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

function callContent(call: CallEmail, origin: string, locale: EmailLocale): EmailContent {
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
  blocks.push(
    { kind: 'button', label: t('email.call.open'), url: callLink(origin, call.workspaceId, call.callId) },
    { kind: 'text', tone: 'muted', text: t('email.call.recording', { brand: brandName() }) },
  )
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
    reason: t('email.call.reason', { workspace: call.workspace }),
    settings: { label: t('email.notificationSettings'), url: notificationsLink(origin, call.workspaceId) },
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
export function assignedCallEmail(a: AssignedCallEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
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
  origin = WEB_ORIGIN,
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
  const brand = brandName()
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
  origin = WEB_ORIGIN,
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
  origin = WEB_ORIGIN,
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
  if (day === 3 && partnerDirectory) {
    blocks.push(
      { kind: 'text', text: t('email.setup.partner', { brand: brandName(), workspace: s.workspace }) },
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
export function firstCallEmail(call: CallEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
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
  origin = WEB_ORIGIN,
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
