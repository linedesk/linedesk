// Outgoing email behind one interface. SMTP when it is connected (Server admin › Providers › Email, or SMTP_URL); with EMAIL_TO_LOG=true the
// message is printed to the server log instead (development); otherwise nothing can be sent. A change applies at once.
import nodemailer from 'nodemailer'
import { emailDelivery } from './auth-methods.ts'
import { emailBrandName, emailFromAddress, emailReplyTo, partnerEmailBrand } from './email-brand.ts'

export interface Email {
  to: string
  subject: string
  text: string
  /** The same content as HTML (emails/layout.ts); mail apps show it, the text part is the fallback. */
  html?: string
  /** Extra headers, e.g. List-Unsubscribe on setup emails. */
  headers?: Record<string, string>
  /** Where replies go; left out: the brand's (a partner's support email inside withEmailBrand), else none. */
  replyTo?: string
}
export interface EmailSender {
  kind: 'smtp' | 'log' | 'none'
  send(email: Email): Promise<void>
  /** Whether email can go out, for the admin overview. SMTP: connects and logs in, nothing is sent. */
  check(): Promise<{ ok: boolean; message: string }>
}

/** How long one email may take. A blocked port (465 behind some firewalls) otherwise hangs forever. */
export type SmtpTimeouts = { connectMs: number; sendMs: number }
const SMTP_TIMEOUTS: SmtpTimeouts = { connectMs: 10_000, sendMs: 30_000 }

/**
 * Some hosts block outgoing port 465 (Hetzner by default): a URL on 465 that gets no answer says so. Saved URLs are
 * left as they are; the operator changes the port.
 */
const blockedPortHint = (host: string) =>
  host.endsWith(':465') ? ' Port 465 may be blocked by your host; try 587 (smtp://user:password@host:587).' : ''

/** Fails with a message an operator can act on instead of waiting forever. */
function withDeadline<T>(work: Promise<T>, ms: number, host: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Could not send email: ${host} did not finish within ${ms / 1000} s. Check the host and port of the SMTP URL.${blockedPortHint(host)}`,
          ),
        ),
      ms,
    )
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

const smtpHost = (url: string) => {
  try {
    const { hostname, port } = new URL(url)
    return port ? `${hostname}:${port}` : hostname
  } catch {
    return 'the mail server'
  }
}

/** Says which mail server failed and why, without the password from SMTP_URL. */
function sendError(e: unknown, host: string): Error {
  const code = (e as { code?: string }).code
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET') {
    return new Error(
      `Could not send email: no answer from ${host} (${code}). Check the host and port of the SMTP URL and that the server may connect to it.${blockedPortHint(host)}`,
    )
  }
  return e instanceof Error ? e : new Error(String(e))
}

/** The address of EMAIL_FROM as set ("Desk <desk@example.com>" or a bare address), or the fallback. */
export const installAddress = (configured: string | undefined) => {
  const value = configured?.trim()
  return value?.match(/<([^<>]+)>\s*$/)?.[1]?.trim() || value || 'no-reply@localhost'
}

/** A partner's From line: its product name, and its own verified address or else the install's. */
export const partnerSenderLine = (name: string, address: string) => `"${name.replace(/["\\<>]/g, '')}" <${address}>`

/**
 * The From line: EMAIL_FROM as set when it names a sender ("Desk <desk@example.com>"); a bare address, or none,
 * gets the install's product name (branding.ts), read at send time so a rename shows in the next email. Inside a
 * partner's email brand (email-brand.ts) the partner's product name replaces any name EMAIL_FROM gives, and the
 * address is the partner's own once its sender domain is verified (S6), else the install's.
 */
export function senderLine(configured: string | undefined): string {
  const value = configured?.trim()
  if (partnerEmailBrand()) return partnerSenderLine(emailBrandName(), emailFromAddress() ?? installAddress(value))
  if (value?.includes('<')) return value
  return `${emailBrandName().replace(/["<>]/g, '')} <${value || 'no-reply@localhost'}>`
}

/** From and Reply-To of an email sent now: the brand's (email-brand.ts) unless the email names its own Reply-To. */
export function envelopeOf(email: Pick<Email, 'replyTo'>, configuredFrom: string | undefined) {
  const replyTo = email.replyTo ?? emailReplyTo()
  return { from: senderLine(configuredFrom), ...(replyTo ? { replyTo } : {}) }
}

/** How each sent or failed email ended, for the provider failure record (provider-failures.ts). */
export type EmailResult = { ok: true } | { ok: false; error: unknown }
let emailResultListener: ((result: EmailResult) => void) | null = null
/** Hears every email's result; one listener (server.ts sets it). */
export const onEmailResult = (listener: ((result: EmailResult) => void) | null) => {
  emailResultListener = listener
}

function smtpSender(url: string, configuredFrom: string | undefined, timeouts: SmtpTimeouts): EmailSender {
  const transport = nodemailer.createTransport({
    url,
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.connectMs,
    socketTimeout: timeouts.sendMs,
  })
  const host = smtpHost(url)
  return {
    kind: 'smtp',
    send: async email => {
      try {
        await withDeadline(
          transport.sendMail({ ...email, ...envelopeOf(email, configuredFrom) }),
          timeouts.sendMs,
          host,
        )
        emailResultListener?.({ ok: true })
      } catch (e) {
        emailResultListener?.({ ok: false, error: e })
        throw sendError(e, host)
      }
    },
    check: async () => {
      try {
        await withDeadline(transport.verify(), timeouts.connectMs * 2, host)
        return { ok: true, message: `Sends through ${host}.` }
      } catch (e) {
        return { ok: false, message: sendError(e, host).message }
      }
    },
  }
}

const logSender: EmailSender = {
  kind: 'log',
  send: async email =>
    console.log(
      `\n[email, not sent: EMAIL_TO_LOG is on]\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`,
    ),
  check: async () => ({
    ok: true,
    message:
      'Printed to the API log (EMAIL_TO_LOG), not sent. Connect email in Server admin › Providers › Email on a real server.',
  }),
}

/** "Test connection" for SMTP in the admin area: connects and logs in, sends nothing. */
export const smtpCheck = (url: string, from?: string) => smtpSender(url, from, SMTP_TIMEOUTS).check()

const noSender: EmailSender = {
  kind: 'none',
  send: async () => {
    throw new Error('Email is not set up: connect it in Server admin › Providers › Email')
  },
  check: async () => ({
    ok: false,
    message:
      'Not set up: connect email in Server admin › Providers › Email. Sign-in codes, invitations and call emails cannot go out.',
  }),
}

/** EMAIL_MUTED_TO: addresses that get no email from this install (comma-separated, any case). */
export const mutedAddresses = (value: string | undefined) =>
  new Set(
    (value ?? '')
      .split(',')
      .map(a => a.trim().toLowerCase())
      .filter(Boolean),
  )

/**
 * Leaves out email to the muted addresses: one log line (to, subject) instead, never the text, as it can hold a
 * sign-in code. For test installs that share a mail account with production (local, staging).
 */
function withMuted(sender: EmailSender, muted: Set<string>): EmailSender {
  if (muted.size === 0) return sender
  return {
    kind: sender.kind,
    send: async email => {
      if (!muted.has(email.to.trim().toLowerCase())) return sender.send(email)
      console.log(`[email, not sent: EMAIL_MUTED_TO] To: ${email.to} Subject: ${email.subject}`)
    },
    check: () => sender.check(),
  }
}

export function createEmailSender(
  env: Record<string, string | undefined>,
  timeouts: SmtpTimeouts = SMTP_TIMEOUTS,
): EmailSender {
  const delivery = emailDelivery(env)
  const sender =
    delivery === 'smtp'
      ? smtpSender(env.SMTP_URL!, env.EMAIL_FROM, timeouts)
      : delivery === 'log'
        ? logSender
        : noSender
  return withMuted(sender, mutedAddresses(env.EMAIL_MUTED_TO))
}

/** What decides how email goes out: two environments with the same value send the same way. */
export const emailSettingsOf = (env: Record<string, string | undefined>) =>
  JSON.stringify([env.SMTP_URL ?? '', env.EMAIL_FROM ?? '', env.EMAIL_TO_LOG ?? '', env.EMAIL_MUTED_TO ?? ''])

let current: { settings: string; sender: EmailSender } | null = null
/** The sender for the settings in process.env now; made again only when they changed. */
function senderNow(): EmailSender {
  const env = process.env
  const settings = emailSettingsOf(env)
  if (current?.settings !== settings) current = { settings, sender: createEmailSender(env) }
  return current.sender
}

/**
 * The install's sender. It follows the email settings as they are now (instance-env.ts copies a saved change into
 * process.env), so email connected in Server admin › Providers sends from the next email on, without a restart.
 */
export const emailSender: EmailSender = {
  get kind() {
    return senderNow().kind
  },
  send: email => senderNow().send(email),
  check: () => senderNow().check(),
}

/**
 * Sends a notice without waiting (an alert, a "your passkeys were reset"): it never holds up what it is about. Without
 * email set up there is nobody to reach: one log line instead of the sender's error with its stack (the CLI on a fresh
 * install has no email yet).
 */
export function sendNotice(email: Email, what: string, sender: EmailSender = emailSender) {
  if (sender.kind === 'none') {
    console.log(`${what} not sent: email is not set up (Server admin › Providers › Email).`)
    return
  }
  void sender.send(email).catch(err => console.error(`${what} failed`, err))
}
