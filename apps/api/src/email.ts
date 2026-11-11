// Outgoing email behind one interface. SMTP when SMTP_URL is set; with EMAIL_TO_LOG=true the
// message is printed to the server log instead (development); otherwise nothing can be sent.
import nodemailer from 'nodemailer'
import { emailDelivery } from './auth-methods.ts'

export interface Email {
  to: string
  subject: string
  text: string
  /** The same content as HTML (emails/layout.ts); mail apps show it, the text part is the fallback. */
  html?: string
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

/** Fails with a message an operator can act on instead of waiting forever. */
function withDeadline<T>(work: Promise<T>, ms: number, host: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Could not send email: ${host} did not finish within ${ms / 1000} s. Check the host and port in SMTP_URL.`,
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
      `Could not send email: no answer from ${host} (${code}). Check the host and port in SMTP_URL and that the server may connect to it.`,
    )
  }
  return e instanceof Error ? e : new Error(String(e))
}

function smtpSender(url: string, from: string, timeouts: SmtpTimeouts): EmailSender {
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
        await withDeadline(transport.sendMail({ from, ...email }), timeouts.sendMs, host)
      } catch (e) {
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
    message: 'Printed to the API log (EMAIL_TO_LOG), not sent. Set SMTP_URL on a real server.',
  }),
}

const noSender: EmailSender = {
  kind: 'none',
  send: async () => {
    throw new Error('Email is not set up: set SMTP_URL')
  },
  check: async () => ({
    ok: false,
    message: 'Not set up: set SMTP_URL. Sign-in codes, invitations and call emails cannot go out.',
  }),
}

export function createEmailSender(
  env: Record<string, string | undefined>,
  timeouts: SmtpTimeouts = SMTP_TIMEOUTS,
): EmailSender {
  const delivery = emailDelivery(env)
  if (delivery === 'smtp') return smtpSender(env.SMTP_URL!, env.EMAIL_FROM || 'Linedesk <no-reply@localhost>', timeouts)
  return delivery === 'log' ? logSender : noSender
}

export const emailSender = createEmailSender(process.env)
