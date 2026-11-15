// Every email Linedesk sends, as pure functions from data to subject, text and HTML (layout.ts).
// The code that decides when to send lives with its feature; these only say what the email shows.
// Names that reach an email go through emailSafeName (team.ts) or defuseLinks first: they come from
// workspaces, members or callers and must not turn into links.
import { type SetupStep, setupStepPath } from '@linedesk/actions'
import { brandName } from '../branding.ts'
import { defuseLinks, type Block, type EmailContent, type RenderedEmail, renderEmail, siteHost } from './layout.ts'

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

/** The code in the subject and the body, and no link: a link in a code email teaches people to click them. */
export function signInCodeEmail(code: string, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `${code} is your ${brandName()} sign-in code`,
    preheader: `Enter it on the sign-in page of ${site}. It expires in ${SIGN_IN_CODE_MINUTES} minutes.`,
    heading: 'Your sign-in code',
    blocks: [
      { kind: 'text', text: `Enter this code on the ${brandName()} sign-in page at ${site}.` },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code: nobody from ${brandName()} or your team will ever ask you for it.`,
      },
    ],
    reason: `You got this email because someone asked to sign in to ${site} with this address. If it wasn't you, you can ignore it.`,
    origin,
  })
}

/**
 * The code that confirms a signed-in member's own address. `site` is the address people open (as for
 * passkeys), so a code someone asks for elsewhere stands out.
 */
export function confirmationCodeEmail(code: string, site: string, origin = WEB_ORIGIN): RenderedEmail {
  return renderEmail({
    subject: `${code} is your ${brandName()} confirmation code`,
    preheader: `It confirms this address for your ${brandName()} account at ${site}.`,
    heading: 'Your confirmation code',
    blocks: [
      {
        kind: 'text',
        text: `This code confirms this address for your ${brandName()} account at ${site}. Enter it on ${site}, where ${brandName()} asked for it.`,
      },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code with anyone; ${brandName()} staff will never ask for it.`,
      },
    ],
    reason:
      "You got this email because your account asked to confirm this address. If it wasn't you, you can ignore it.",
    origin,
  })
}

/**
 * The code that sets a new password ("Forgot password?" on the sign-in page). Like the sign-in code:
 * the code in the subject and the body, and no link.
 */
export function passwordResetCodeEmail(code: string, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `${code} is your ${brandName()} password reset code`,
    preheader: `Enter it on the sign-in page of ${site} to set a new password. It expires in ${SIGN_IN_CODE_MINUTES} minutes.`,
    heading: 'Reset your password',
    blocks: [
      {
        kind: 'text',
        text: `Enter this code on the ${brandName()} sign-in page at ${site}, then choose a new password.`,
      },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code: nobody from ${brandName()} or your team will ever ask you for it.`,
      },
    ],
    reason: `You got this email because someone asked to reset the password for this address on ${site}. If it wasn't you, you can ignore it: your password stays the same.`,
    origin,
  })
}

export type InvitationEmail = { inviter: string; workspace: string; email: string; url: string; days: number }

/** `inviter` and `workspace` are already email-safe (emailSafeName). */
export function invitationEmail(
  { inviter, workspace, email, url, days }: InvitationEmail,
  origin = WEB_ORIGIN,
): RenderedEmail {
  return renderEmail({
    subject: `Join ${workspace} on ${brandName()}`,
    preheader: `${inviter} invited you. The invitation is open for ${days} days.`,
    heading: `Join ${workspace} on ${brandName()}`,
    blocks: [
      {
        kind: 'text',
        text: `${inviter} invited you to join ${workspace}: answer and follow up on the calls its assistant takes.`,
      },
      { kind: 'button', label: 'Accept invitation', url },
      {
        kind: 'text',
        tone: 'muted',
        text: `The link works for ${days} days. Sign in or create your account with this address (${email}).`,
      },
    ],
    reason: "You got this email because someone invited this address. If you didn't expect it, you can ignore it.",
    origin,
  })
}

/**
 * An instance admin added this address to a workspace (Server admin › Users › Add user, `user.invite`): the one email they
 * get, instead of the plain invitation and the welcome email. The link is the invitation's: they sign in with this
 * address (a code proves it) and join. `inviter` and `workspace` are already email-safe.
 */
export function addedToWorkspaceEmail(
  { inviter, workspace, email, url, days, role }: InvitationEmail & { role: string },
  origin = WEB_ORIGIN,
): RenderedEmail {
  const site = siteHost(origin)
  const as = role === 'owner' ? 'an owner' : role === 'admin' ? 'an admin' : 'a member'
  return renderEmail({
    subject: `You were added to ${workspace} on ${site}`,
    preheader: `${inviter} added you as ${as}. Sign in with this address to join.`,
    heading: `You were added to ${workspace}`,
    blocks: [
      {
        kind: 'text',
        text: `${inviter} added you to ${workspace} on ${site} as ${as}: answer and follow up on the calls its assistant takes.`,
      },
      { kind: 'facts', rows: [['Sign in with', email]] },
      { kind: 'button', label: `Join ${workspace}`, url },
      {
        kind: 'text',
        tone: 'muted',
        text: `The link works for ${days} days. Enter this email address on the sign-in page and we send you a code.`,
      },
    ],
    reason: `You got this email because an administrator of ${site} added this address. If you didn't expect it, you can ignore it.`,
    origin,
  })
}

/** "a member", "an admin", "an owner". */
const roleWithArticle = (role: string) => (role === 'owner' ? 'an owner' : role === 'admin' ? 'an admin' : 'a member')

/**
 * To someone an instance admin added to a workspace directly (their address was confirmed already, so there is no
 * invitation to accept). `admin` and `workspace` are already email-safe.
 */
export function addedNoticeEmail(
  { admin, workspace, workspaceId, role }: { admin: string; workspace: string; workspaceId: string; role: string },
  origin = WEB_ORIGIN,
): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `You were added to ${workspace} on ${site}`,
    preheader: `${admin} added you as ${roleWithArticle(role)}.`,
    heading: `You were added to ${workspace}`,
    blocks: [
      { kind: 'text', text: `${admin} added you to ${workspace} on ${site} as ${roleWithArticle(role)}.` },
      { kind: 'button', label: `Open ${workspace}`, url: appLink(origin, workspaceId, 'calls') },
    ],
    reason: `You got this email because an administrator of ${site} added you. If you didn't expect it, tell the workspace's owner.`,
    origin,
  })
}

/**
 * To a workspace's owners when an instance admin adds someone to it or invites them (Server admin, membership.add,
 * user.invite): a change to who can see the workspace that its owners did not make. `pending`: an invitation, the
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
): RenderedEmail {
  const text = `${admin} added ${who} to ${workspace} as ${roleWithArticle(role)}.`
  return renderEmail({
    subject: `${admin} added ${who} to ${workspace}`,
    preheader: text,
    eyebrow: 'Team notice',
    heading: `${who} was added to ${workspace}`,
    blocks: [
      { kind: 'text', text: pending ? `${text} They join once they confirm their email address.` : text },
      { kind: 'text', text: 'If you did not expect this, check the team and remove them there.' },
      { kind: 'button', label: 'Open the team', url: appLink(origin, workspaceId, 'workspace/team') },
    ],
    reason: `You got this email because you own ${workspace}, and an administrator of ${siteHost(origin)} changed its team. We always send it.`,
    origin,
  })
}

/**
 * To every other member when an owner deletes the workspace (workspace.deleteOwn). `workspace` and `by` are already
 * email-safe; `when` is formatted in the workspace's time zone. `accountDeleted`: their account went with it (no
 * other workspace).
 */
export type WorkspaceDeletedEmail = { workspace: string; by: string; when: string; accountDeleted: boolean }

export function workspaceDeletedEmail(
  { workspace, by, when, accountDeleted }: WorkspaceDeletedEmail,
  origin = WEB_ORIGIN,
): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `${workspace} was deleted on ${brandName()}`,
    preheader: `${by} deleted it on ${when}.`,
    eyebrow: 'Account notice',
    heading: `${workspace} was deleted`,
    blocks: [
      {
        kind: 'text',
        text: `${by} deleted the workspace ${workspace} on ${when}. Its calls, contacts, recordings and settings are gone, and nobody can open it any more.`,
      },
      accountDeleted
        ? {
            kind: 'text',
            text: `Your ${brandName()} account at ${site} was deleted with it, because you belonged to no other workspace. You can't sign in there any more.`,
          }
        : { kind: 'text', text: 'Your account and your other workspaces stay as they are.' },
      ...(accountDeleted ? [] : [{ kind: 'button' as const, label: `Open ${brandName()}`, url: origin }]),
      { kind: 'text', tone: 'muted', text: 'If you did not expect this, ask the workspace owner.' },
    ],
    reason: `You got this email because you were a member of ${workspace} on ${site}. We always send it.`,
    origin,
  })
}

/** No code in it: codes expire in 10 minutes, a welcome may be read later. The sign-in page sends one. */
export function welcomeEmail({ name, email }: { name: string; email: string }, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `Your ${brandName()} account is ready`,
    preheader: `Sign in at ${site} with this address.`,
    heading: `Welcome, ${name}`,
    blocks: [
      { kind: 'text', text: `An administrator created a ${brandName()} account for you at ${site}.` },
      { kind: 'facts', rows: [['Sign in with', email]] },
      { kind: 'button', label: 'Sign in', url: origin },
      { kind: 'text', tone: 'muted', text: 'Enter this email address on the sign-in page and we send you a code.' },
    ],
    reason: `You got this email because an administrator of ${site} added you.`,
    origin,
  })
}

// ---------------------------------------------------------------- security notices

export function passkeyChangedEmail(change: 'added' | 'removed', origin = WEB_ORIGIN): RenderedEmail {
  const what = change === 'added' ? 'A passkey was added to' : 'A passkey was removed from'
  return renderEmail({
    subject: `${what} your ${brandName()} account`,
    preheader: 'If this was you, there is nothing to do.',
    eyebrow: 'Security notice',
    heading: change === 'added' ? 'A passkey was added' : 'A passkey was removed',
    blocks: [
      {
        kind: 'text',
        text: `${what} your ${brandName()} account at ${siteHost(origin)}. If this was you, there is nothing to do.`,
      },
      {
        kind: 'text',
        text: `If it was not you, ask an instance admin of your ${brandName()} to remove all passkeys of your account (Server admin › Users, your name, Reset passkeys), then sign in and add your own again.`,
      },
      { kind: 'button', label: 'Review sign-in & security', url: securityUrl(origin) },
    ],
    reason: 'You got this email because the sign-in methods of your account changed. We always send it.',
    origin,
  })
}

/** After a password reset by emailed code: every session of the account was ended. */
export function passwordChangedEmail(origin = WEB_ORIGIN): RenderedEmail {
  return renderEmail({
    subject: `The password of your ${brandName()} account was changed`,
    preheader: 'If this was you, there is nothing to do.',
    eyebrow: 'Security notice',
    heading: 'Your password was changed',
    blocks: [
      {
        kind: 'text',
        text: `The password of your ${brandName()} account at ${siteHost(origin)} was reset with a code sent to this address, and you were signed out everywhere. If this was you, there is nothing to do.`,
      },
      {
        kind: 'text',
        text: 'If it was not you, someone can read your email: secure your mailbox first, then use "Forgot password?" on the sign-in page to set a new password, and tell your administrator.',
      },
      { kind: 'button', label: 'Review sign-in & security', url: securityUrl(origin) },
    ],
    reason: 'You got this email because the sign-in methods of your account changed. We always send it.',
    origin,
  })
}

/**
 * The code that moves an account to a new address (Account settings › Profile › Change), sent to the
 * new address: proving it is the change. Like the other codes: in the subject and the body, no link.
 */
export function emailChangeCodeEmail(code: string, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `${code} is your ${brandName()} code to change your email`,
    preheader: `Enter it in Account settings on ${site} to sign in with this address from now on.`,
    heading: 'Confirm your new email address',
    blocks: [
      {
        kind: 'text',
        text: `Enter this code in Account settings on ${site}. Your ${brandName()} account then uses this address to sign in and for its emails.`,
      },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code: nobody from ${brandName()} or your team will ever ask you for it.`,
      },
    ],
    reason: `You got this email because someone signed in to ${brandName()} on ${site} asked to use this address for their account. If it wasn't you, you can ignore it: nothing changes without this code.`,
    origin,
  })
}

/**
 * The first step of an email change in a session without a recent passkey sign-in: a code to the
 * current address proves the person asking still has it, so a stolen password alone can't move the
 * account. No link, as the other codes.
 */
export function emailChangeConfirmCurrentEmail(code: string, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `${code} is your ${brandName()} code to confirm it's you`,
    preheader: `Someone signed in to your account on ${site} wants to change its email address.`,
    heading: "Confirm it's you",
    blocks: [
      {
        kind: 'text',
        text: `Someone signed in to your ${brandName()} account on ${site} wants to change its email address. Enter this code in Account settings to confirm it's you.`,
      },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code: nobody from ${brandName()} or your team will ever ask you for it.`,
      },
    ],
    reason:
      "You got this email because it is the address of your account. If it wasn't you, don't enter the code: change your password and tell your administrator.",
    origin,
  })
}

/**
 * Sent instead of the code when the new address already has an account (or is reserved for an
 * administrator): only the mailbox's owner learns that it cannot be used, never the person asking.
 */
export function emailChangeRefusedEmail(origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `This address can't be used for another ${brandName()} account`,
    preheader: 'Someone asked to move their account to this address. Nothing was changed.',
    heading: "This address can't be used",
    blocks: [
      {
        kind: 'text',
        text: `Someone signed in to ${brandName()} on ${site} asked to use this address for their account. It already belongs to an account there or is kept for an administrator, so it can't be used for another one, and nothing was changed.`,
      },
      {
        kind: 'text',
        tone: 'muted',
        text: 'If that was you, use a different address, or sign in with this one instead. If it was not you, you can ignore this email.',
      },
    ],
    reason: 'You got this email because this address was entered as a new sign-in address. We always send it.',
    origin,
  })
}

/** To the old address once an account moved to a new one: the only place the real owner can still be told. */
export function emailChangedEmail(newEmail: string, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  const shown = defuseLinks(newEmail)
  return renderEmail({
    subject: `The email of your ${brandName()} account was changed`,
    preheader: `Your account now signs in with ${shown}.`,
    eyebrow: 'Security notice',
    heading: 'Your email address was changed',
    blocks: [
      {
        kind: 'text',
        text: `Your ${brandName()} account at ${site} now uses ${shown} to sign in and for its emails, and its other sessions were signed out. This address no longer signs in to it. If this was you, there is nothing to do.`,
      },
      {
        kind: 'text',
        text: 'If it was not you, someone has access to your account: tell your administrator right away, so they can turn the account off.',
      },
    ],
    reason: 'You got this email because it was the address of your account until now. We always send it.',
    origin,
  })
}

/** When an admin resets someone's passkeys (also with none to remove, for an instance admin). */
export function passkeysResetEmail(removed: number, origin = WEB_ORIGIN): RenderedEmail {
  const what =
    removed > 0
      ? `An administrator removed every passkey of your ${brandName()} account and signed you out everywhere.`
      : `An administrator issued a passkey enrolment code for your ${brandName()} account and signed you out everywhere.`
  return renderEmail({
    subject:
      removed > 0
        ? `The passkeys of your ${brandName()} account were removed`
        : `A passkey enrolment code was issued for your ${brandName()} account`,
    preheader: 'Sign in again, then add a new passkey.',
    eyebrow: 'Security notice',
    heading: removed > 0 ? 'Your passkeys were removed' : 'Passkey enrolment code issued',
    blocks: [
      { kind: 'text', text: what },
      {
        kind: 'text',
        text: 'Sign in with an email code or your password, then add a new passkey under Account, Sign-in & security.',
      },
      { kind: 'button', label: 'Sign in', url: origin },
      { kind: 'text', tone: 'muted', text: 'If you did not ask for this, tell your administrator.' },
    ],
    reason: 'You got this email because the sign-in methods of your account changed. We always send it.',
    origin,
  })
}

/**
 * An administrator issued the code for the first passkey of an instance admin who has none (user.issuePasskeyEnrolment):
 * nothing was removed and nobody was signed out. `issuedBy`: the admin's address, or the server operator.
 */
export function passkeyEnrolmentIssuedEmail(issuedBy: string, origin = WEB_ORIGIN): RenderedEmail {
  return renderEmail({
    subject: `A passkey enrolment code was issued for your ${brandName()} account`,
    preheader: 'Use it to add your first passkey. Nothing else changed.',
    eyebrow: 'Security notice',
    heading: 'Passkey enrolment code issued',
    blocks: [
      {
        kind: 'text',
        text: `${issuedBy} issued a one-time code for the first passkey of your ${brandName()} account. Nothing was removed and you are still signed in.`,
      },
      {
        kind: 'text',
        text: 'Get the code from them, then add your passkey under Account, Sign-in & security.',
      },
      { kind: 'button', label: 'Open Sign-in & security', url: `${origin}/#account/security` },
      {
        kind: 'text',
        tone: 'muted',
        text: `If you did not ask for this, tell the other administrators of ${brandName()} at once: whoever has the code can add a passkey to your account.`,
      },
    ],
    reason: 'You got this email because the sign-in methods of your account changed. We always send it.',
    origin,
  })
}

/** An alert to every instance admin (admin-alerts.ts). `text` is already plain and link-free; blank lines split paragraphs. */
export function adminAlertEmail(subject: string, text: string, origin = WEB_ORIGIN): RenderedEmail {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
  return renderEmail({
    subject,
    preheader: paragraphs[0] ?? subject,
    eyebrow: 'Admin alert',
    heading: subject,
    blocks: [
      ...paragraphs.map(p => ({ kind: 'text', text: p }) as const),
      { kind: 'button', label: 'Open the audit log', url: `${origin}/#admin/audit` },
    ],
    reason: `You got this email because you are an instance admin of ${siteHost(origin)}. Every instance admin gets these alerts.`,
    origin,
  })
}

// ---------------------------------------------------------------- calls

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

const minutes = (sec: number) => `${Math.max(1, Math.round(sec / 60))} min`

/** One finished call: what it was about, who called, the summary, next steps, the booking and a link. */
export const callEmail = (call: CallEmail, origin = WEB_ORIGIN): RenderedEmail => renderEmail(callContent(call, origin))

function callContent(call: CallEmail, origin: string): EmailContent {
  const number = formatNumber(call.fromNumber)
  const callerName = call.callerName ? defuseLinks(call.callerName) : null
  const topic = call.title ? defuseLinks(call.title) : 'New call'
  const at = new Date(call.startedAt)
    .toLocaleString('en-US', { timeZone: call.timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, ' ') // plain spaces: some mail apps show the narrow one as a box
  const eyebrow = [`${call.assistantName} answered`, at, call.durationSec ? minutes(call.durationSec) : null]
    .filter(Boolean)
    .join(' · ')
  const blocks: Block[] = [
    {
      kind: 'facts',
      rows: [
        ['Caller', callerName ?? 'Unknown caller'],
        ['Number', number],
      ],
    },
  ]
  if (call.summary) blocks.push({ kind: 'text', text: defuseLinks(call.summary) })
  if (call.nextSteps.length) blocks.push({ kind: 'list', title: 'Next steps', items: call.nextSteps.map(defuseLinks) })
  if (call.booking) {
    blocks.push({
      kind: 'facts',
      title: 'Booked',
      rows: [
        ['What', defuseLinks(call.booking.what)],
        ['When', call.booking.when],
      ],
    })
  }
  blocks.push(
    { kind: 'button', label: 'Open the call', url: callLink(origin, call.workspaceId, call.callId) },
    { kind: 'text', tone: 'muted', text: `The recording and the transcript are in ${brandName()}.` },
  )
  return {
    subject: `${call.urgent ? 'Urgent: ' : ''}${topic} · ${callerName ?? number}`,
    preheader: call.summary
      ? defuseLinks(call.summary).slice(0, 140)
      : `${call.assistantName} answered a call from ${callerName ?? number}.`,
    eyebrow,
    urgent: call.urgent ? 'Urgent' : undefined,
    heading: topic,
    blocks,
    reason: `You get one email per call to ${call.workspace}.`,
    settings: { label: 'Change in Account settings, Notifications', url: notificationsLink(origin, call.workspaceId) },
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
export function assignedCallEmail(a: AssignedCallEmail, origin = WEB_ORIGIN): RenderedEmail {
  const number = formatNumber(a.fromNumber)
  const callerName = a.callerName ? defuseLinks(a.callerName) : null
  const topic = a.title ? defuseLinks(a.title) : `Call from ${callerName ?? number}`
  const blocks: Block[] = [
    {
      kind: 'facts',
      rows: [
        ['Caller', callerName ?? 'Unknown caller'],
        ['Number', number],
      ],
    },
  ]
  if (a.summary) blocks.push({ kind: 'text', text: defuseLinks(a.summary) })
  blocks.push({ kind: 'button', label: 'Open the call', url: callLink(origin, a.workspaceId, a.callId) })
  return renderEmail({
    subject: `${a.assignedBy} assigned you a call: ${topic}`,
    preheader: `${a.assignedBy} assigned you a call from ${callerName ?? number}.`,
    eyebrow: `Assigned to you by ${a.assignedBy}`,
    urgent: a.urgent ? 'Urgent' : undefined,
    heading: topic,
    blocks,
    reason: `You got this email because a teammate in ${a.workspace} assigned you a call.`,
    settings: { label: 'Change in Account settings, Notifications', url: notificationsLink(origin, a.workspaceId) },
    origin,
  })
}

// ---------------------------------------------------------------- to callers

export type BookingConfirmation = {
  /** Email-safe (emailSafeName). */
  business: string
  /** The appointment type, lower case ("repair visit"). */
  what: string
  /** Date and time with the time zone ("Tuesday, November 17 at 9:00 AM PST"). */
  when: string
  minutes: number | null
  /** Where the appointment is, as the caller gave it. */
  address: string | null
  /** The number to call to change it: the business's own. */
  phone: string | null
}

/** No link: the caller has no account. They change the booking by calling. */
export function bookingConfirmationEmail(b: BookingConfirmation, origin = WEB_ORIGIN): RenderedEmail {
  const rows: [string, string][] = [['When', b.when]]
  if (b.minutes) rows.push(['Length', `${b.minutes} minutes`])
  if (b.address) rows.push(['Where', defuseLinks(b.address)])
  const change = b.phone
    ? `To change or cancel it, call ${b.business} at ${formatNumber(b.phone)}.`
    : `To change or cancel it, call ${b.business} back.`
  return renderEmail({
    subject: `Confirmed: your ${b.what} with ${b.business}, ${b.when}`,
    preheader: `${b.when}. ${change}`,
    business: b.business,
    eyebrow: 'Booking confirmed',
    heading: `Your ${b.what} is booked`,
    blocks: [
      { kind: 'facts', title: b.business, rows },
      { kind: 'text', text: change },
    ],
    reason: `You got this email because you booked by phone with ${b.business} and gave this address.`,
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
const setupButton = (s: SetupEmail, origin: string) => ({
  kind: 'button' as const,
  label: s.step === 'first_call' ? 'Open your inbox' : 'Finish setup',
  url: appLink(origin, s.workspaceId, setupStepPath(s.step, s.numberId ? { id: s.numberId } : null)),
})
/** Where a setup email's footer link goes: the one-click unsubscribe link when there is one, else the signed-in setting. */
const setupSettings = (origin: string, workspaceId: string, unsubscribeUrl?: string | null) => ({
  label: 'Turn off setup emails',
  url: unsubscribeUrl ?? notificationsLink(origin, workspaceId),
})
const setupFooter = (
  s: { workspaceId: string; workspace: string; assistantName: string },
  origin: string,
  unsubscribeUrl?: string | null,
) => ({
  reason: `You get a few emails while ${s.workspace} gets set up. They stop once ${s.assistantName} answers real calls.`,
  settings: setupSettings(origin, s.workspaceId, unsubscribeUrl),
})

/** The one next step, plain. */
function nextStep({ assistantName: a, number, takesAllCalls, step }: SetupEmail): string {
  if (step === 'number') return `Pick a phone number for ${a}. It takes a minute in ${brandName()}.`
  // Calls from the business's own phones are the owner trying it out and never count as real calls.
  // A teammate whose phone takes transferred calls counts as the business's own too, so: a friend's.
  const from = "from a phone that isn't one of yours (a friend's)"
  if (step === 'first_call')
    return takesAllCalls
      ? `Call your business number ${from}: ${a} answers.`
      : `Call your business number ${from} and let it ring. When you don't pick up, ${a} does.`
  const to = number ? formatNumber(number) : `your ${brandName()} number`
  const what = takesAllCalls ? 'your business line' : "the calls you don't pick up on your business line"
  return `If you haven't yet, forward ${what} to ${to}. The steps for your phone company are in ${brandName()}.`
}

/** A few hours after sign-up, while no real call has reached the assistant yet: what is left. */
export function setupDay0Email(s: SetupEmail, origin = WEB_ORIGIN, unsubscribeUrl?: string | null): RenderedEmail {
  return renderEmail({
    subject: `${s.assistantName} is almost ready to answer for ${s.workspace}`,
    preheader: nextStep(s),
    heading: s.step === 'first_call' ? 'Try it with a real call' : 'One step left',
    blocks: [
      {
        kind: 'text',
        text: `${s.assistantName} is set up for ${s.workspace}. One thing is left before callers reach ${s.assistantName}:`,
      },
      { kind: 'text', text: nextStep(s) },
      setupButton(s, origin),
    ],
    ...setupFooter(s, origin, unsubscribeUrl),
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
): RenderedEmail {
  const blocks: Block[] = [
    { kind: 'text', text: `No real calls have reached ${s.assistantName} yet. The one thing left:` },
    { kind: 'text', text: nextStep(s) },
    setupButton(s, origin),
  ]
  if (day === 3 && partnerDirectory) {
    blocks.push(
      {
        kind: 'text',
        text: `Rather have someone do it for you? A partner can set up ${brandName()} for ${s.workspace}, phone settings included.`,
      },
      { kind: 'button', label: 'Find a partner', url: partnerDirectory },
    )
  }
  return renderEmail({
    subject:
      day === 1
        ? `${s.assistantName} hasn't answered a real call yet`
        : `Still one step before ${s.assistantName} answers your calls`,
    preheader: nextStep(s),
    heading: day === 1 ? 'No calls yet' : 'One step left',
    blocks,
    ...setupFooter(s, origin, unsubscribeUrl),
    origin,
  })
}

/** The first real call: the call email, as a moment. Sent instead of the usual one to members who get call emails. */
export function firstCallEmail(call: CallEmail, origin = WEB_ORIGIN): RenderedEmail {
  const content = callContent(call, origin)
  const callerName = call.callerName ? defuseLinks(call.callerName) : null
  return renderEmail({
    ...content,
    subject: `${call.urgent ? 'Urgent: ' : ''}Your first real call · ${callerName ?? formatNumber(call.fromNumber)}`,
    heading: 'Your first call',
    blocks: [
      {
        kind: 'text',
        text: `The first real call to ${call.workspace} just came in${call.title ? `: ${defuseLinks(call.title)}.` : '.'}`,
      },
      ...content.blocks,
    ],
    reason: `From now on you get one email per call to ${call.workspace}.`,
  })
}

export type WeekSummaryEmail = {
  /** The workspace the email is about: its links open there. */
  workspaceId: string
  /** Email-safe (emailSafeName), like the assistant's name. */
  workspace: string
  assistantName: string
  /** Real calls since sign-up (not tests, not the business's own phones, not spam). */
  calls: number
  urgent: number
  booked: number
  messages: number
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** A week after sign-up, for a business that is live: what its assistant did. */
export function weekSummaryEmail(
  w: WeekSummaryEmail,
  origin = WEB_ORIGIN,
  unsubscribeUrl?: string | null,
): RenderedEmail {
  const answered = plural(w.calls, 'call', 'calls')
  return renderEmail({
    subject: `${w.assistantName}'s first week at ${w.workspace}`,
    preheader: `${w.assistantName} answered ${answered} in the first week.`,
    heading: 'Your first week',
    blocks: [
      { kind: 'text', text: `In its first week, ${w.assistantName} answered ${answered} for ${w.workspace}.` },
      {
        kind: 'facts',
        rows: [
          ['Calls answered', String(w.calls)],
          ['Urgent', String(w.urgent)],
          ['Appointments booked', String(w.booked)],
          ['Messages taken', String(w.messages)],
        ],
      },
      { kind: 'button', label: 'Open the inbox', url: appLink(origin, w.workspaceId, 'calls') },
    ],
    reason: `You get this once, a week after ${w.workspace} signed up.`,
    settings: setupSettings(origin, w.workspaceId, unsubscribeUrl),
    origin,
  })
}
