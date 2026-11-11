// Every email Linedesk sends, as pure functions from data to subject, text and HTML (layout.ts).
// The code that decides when to send lives with its feature; these only say what the email shows.
// Names that reach an email go through emailSafeName (team.ts) or defuseLinks first: they come from
// workspaces, members or callers and must not turn into links.
import { defuseLinks, type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'

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

// ---------------------------------------------------------------- sign-in and account

export const SIGN_IN_CODE_MINUTES = 10

/** The code in the subject and the body, and no link: a link in a code email teaches people to click them. */
export function signInCodeEmail(code: string, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: `${code} is your Linedesk sign-in code`,
    preheader: `Enter it on the sign-in page of ${site}. It expires in ${SIGN_IN_CODE_MINUTES} minutes.`,
    heading: 'Your sign-in code',
    blocks: [
      { kind: 'text', text: `Enter this code on the Linedesk sign-in page at ${site}.` },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code: nobody from Linedesk or your team will ever ask you for it.`,
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
    subject: `${code} is your Linedesk confirmation code`,
    preheader: `It confirms this address for your Linedesk account at ${site}.`,
    heading: 'Your confirmation code',
    blocks: [
      {
        kind: 'text',
        text: `This code confirms this address for your Linedesk account at ${site}. Enter it on ${site}, where Linedesk asked for it.`,
      },
      { kind: 'code', code },
      {
        kind: 'text',
        tone: 'muted',
        text: `It works once and expires in ${SIGN_IN_CODE_MINUTES} minutes. Don't share this code with anyone; Linedesk staff will never ask for it.`,
      },
    ],
    reason:
      "You got this email because your account asked to confirm this address. If it wasn't you, you can ignore it.",
    origin,
  })
}

/** Better Auth's link that confirms an address, for someone who signed up with a password. */
export function verifyEmailEmail(url: string, origin = WEB_ORIGIN): RenderedEmail {
  return renderEmail({
    subject: 'Confirm your email for Linedesk',
    preheader: 'One click confirms this address for your Linedesk account.',
    heading: 'Confirm your email address',
    blocks: [
      { kind: 'text', text: `Confirm this address to accept your invitation on ${siteHost(origin)}.` },
      { kind: 'button', label: 'Confirm email address', url },
      { kind: 'text', tone: 'muted', text: `Or paste this link into your browser:\n${url}` },
    ],
    reason:
      "You got this email because this address was used to sign up for Linedesk. If it wasn't you, you can ignore it.",
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
    subject: `Join ${workspace} on Linedesk`,
    preheader: `${inviter} invited you. The invitation is open for ${days} days.`,
    heading: `Join ${workspace} on Linedesk`,
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

/** No code in it: codes expire in 10 minutes, a welcome may be read later. The sign-in page sends one. */
export function welcomeEmail({ name, email }: { name: string; email: string }, origin = WEB_ORIGIN): RenderedEmail {
  const site = siteHost(origin)
  return renderEmail({
    subject: 'Your Linedesk account is ready',
    preheader: `Sign in at ${site} with this address.`,
    heading: `Welcome, ${name}`,
    blocks: [
      { kind: 'text', text: `An administrator created a Linedesk account for you at ${site}.` },
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
    subject: `${what} your Linedesk account`,
    preheader: 'If this was you, there is nothing to do.',
    eyebrow: 'Security notice',
    heading: change === 'added' ? 'A passkey was added' : 'A passkey was removed',
    blocks: [
      {
        kind: 'text',
        text: `${what} your Linedesk account at ${siteHost(origin)}. If this was you, there is nothing to do.`,
      },
      {
        kind: 'text',
        text: 'If it was not you, ask an instance admin of your Linedesk to remove all passkeys of your account (Admin, Users, your name, Reset passkeys), then sign in and add your own again.',
      },
      { kind: 'button', label: 'Review sign-in & security', url: securityUrl(origin) },
    ],
    reason: 'You got this email because the sign-in methods of your account changed. We always send it.',
    origin,
  })
}

/** When an admin resets someone's passkeys (also with none to remove, for an instance admin). */
export function passkeysResetEmail(removed: number, origin = WEB_ORIGIN): RenderedEmail {
  const what =
    removed > 0
      ? 'An administrator removed every passkey of your Linedesk account and signed you out everywhere.'
      : 'An administrator issued a passkey enrolment code for your Linedesk account and signed you out everywhere.'
  return renderEmail({
    subject:
      removed > 0
        ? 'The passkeys of your Linedesk account were removed'
        : 'A passkey enrolment code was issued for your Linedesk account',
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
export function callEmail(call: CallEmail, origin = WEB_ORIGIN): RenderedEmail {
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
    { kind: 'button', label: 'Open the call', url: `${origin}/#call/${encodeURIComponent(call.callId)}` },
    { kind: 'text', tone: 'muted', text: 'The recording and the transcript are in Linedesk.' },
  )
  return renderEmail({
    subject: `${call.urgent ? 'Urgent: ' : ''}${topic} · ${callerName ?? number}`,
    preheader: call.summary
      ? defuseLinks(call.summary).slice(0, 140)
      : `${call.assistantName} answered a call from ${callerName ?? number}.`,
    eyebrow,
    urgent: call.urgent ? 'Urgent' : undefined,
    heading: topic,
    blocks,
    reason: `You get one email per call to ${call.workspace}.`,
    settings: { label: 'Change in Settings, Notifications', url: `${origin}/#settings/notifications` },
    origin,
  })
}

export type AssignedCallEmail = {
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
  blocks.push({ kind: 'button', label: 'Open the call', url: `${origin}/#call/${encodeURIComponent(a.callId)}` })
  return renderEmail({
    subject: `${a.assignedBy} assigned you a call: ${topic}`,
    preheader: `${a.assignedBy} assigned you a call from ${callerName ?? number}.`,
    eyebrow: `Assigned to you by ${a.assignedBy}`,
    urgent: a.urgent ? 'Urgent' : undefined,
    heading: topic,
    blocks,
    reason: `You got this email because a teammate in ${a.workspace} assigned you a call.`,
    settings: { label: 'Change in Settings, Notifications', url: `${origin}/#settings/notifications` },
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
