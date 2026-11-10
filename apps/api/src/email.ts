// Outgoing email behind one interface. SMTP when SMTP_URL is set; with EMAIL_TO_LOG=true the
// message is printed to the server log instead (development); otherwise nothing can be sent.
import nodemailer from 'nodemailer'
import { emailDelivery } from './auth-methods.ts'

export interface Email { to: string; subject: string; text: string }
export interface EmailSender { kind: 'smtp' | 'log' | 'none'; send(email: Email): Promise<void> }

function smtpSender(url: string, from: string): EmailSender {
  const transport = nodemailer.createTransport(url)
  return { kind: 'smtp', send: async email => void (await transport.sendMail({ from, ...email })) }
}

const logSender: EmailSender = {
  kind: 'log',
  send: async email => console.log(`\n[email, not sent: EMAIL_TO_LOG is on]\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`),
}

const noSender: EmailSender = {
  kind: 'none',
  send: async () => {
    throw new Error('Email is not set up: set SMTP_URL')
  },
}

export function createEmailSender(env: Record<string, string | undefined>): EmailSender {
  const delivery = emailDelivery(env)
  if (delivery === 'smtp') return smtpSender(env.SMTP_URL!, env.EMAIL_FROM || 'Linedesk <no-reply@localhost>')
  return delivery === 'log' ? logSender : noSender
}

export const emailSender = createEmailSender(process.env)
