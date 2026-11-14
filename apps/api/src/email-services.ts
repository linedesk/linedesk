// Mail services with a key or an app password (Resend, Postmark, SendGrid, Brevo, Mailgun, Gmail) as the SMTP
// connection the API sends with. Their fields are stored like any provider's; at start (instance-env.ts) the one
// that sends becomes SMTP_URL and EMAIL_FROM, so the mail transport (email.ts) stays plain SMTP.
import { type ProviderName, providerSpec, providersIn } from '@linedesk/actions'

type Values = Record<string, string | undefined>
export type SmtpConnection = { url: string; from?: string }
export type MailService = 'resend' | 'postmark' | 'sendgrid' | 'brevo' | 'mailgun' | 'gmail'

const enc = (value: string) => encodeURIComponent(value.trim())

/**
 * The port rule for every preset: 587 with STARTTLS, and STARTTLS required (`requireTLS`, read by nodemailer from
 * the URL), so the key never goes out in clear text and a server that does not offer TLS is refused. 587 is open on
 * every host we know; 465 (implicit TLS) is blocked outgoing on some, Hetzner among them, and every preset service
 * takes 587 with STARTTLS. Plain SMTP (Server admin › Providers › SMTP) keeps the URL the operator wrote.
 */
const STARTTLS_587 = '587?requireTLS=true'

/** Each service's SMTP URL from its fields (in clear). Only called with every needed field set. */
const smtpUrls: Record<MailService, (v: Values) => string> = {
  resend: v => `smtp://resend:${enc(v.api_key!)}@smtp.resend.com:${STARTTLS_587}`,
  postmark: v => `smtp://${enc(v.server_token!)}:${enc(v.server_token!)}@smtp.postmarkapp.com:${STARTTLS_587}`,
  sendgrid: v => `smtp://apikey:${enc(v.api_key!)}@smtp.sendgrid.net:${STARTTLS_587}`,
  brevo: v => `smtp://${enc(v.login!)}:${enc(v.smtp_key!)}@smtp-relay.brevo.com:${STARTTLS_587}`,
  mailgun: v =>
    `smtp://${enc(v.smtp_user!)}:${enc(v.smtp_password!)}@${v.region?.trim().toLowerCase() === 'eu' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org'}:${STARTTLS_587}`,
  // Google shows app passwords in groups of four: the spaces are not part of it.
  gmail: v => `smtp://${enc(v.address!)}:${enc(v.app_password!.replace(/\s+/g, ''))}@smtp.gmail.com:${STARTTLS_587}`,
}

export const isMailService = (provider: ProviderName): provider is MailService => provider in smtpUrls

/** A mail service's SMTP connection from its field values; null when it is not one or a needed field is empty. */
export function smtpOf(provider: ProviderName, values: Values): SmtpConnection | null {
  if (!isMailService(provider)) return null
  const build = smtpUrls[provider]
  const fields = Object.entries(providerSpec(provider).fields)
  if (fields.some(([field, spec]) => !spec.optional && !values[field]?.trim())) return null
  const from = values.from?.trim() || (provider === 'gmail' ? values.address?.trim() : undefined)
  return { url: build(values), ...(from ? { from } : {}) }
}

/** A provider's values as the environment holds them (its variables). */
const valuesFromEnv = (provider: ProviderName, env: Values): Values =>
  Object.fromEntries(Object.entries(providerSpec(provider).fields).map(([field, spec]) => [field, env[spec.env]]))

/**
 * The mail service that sends, when it is not plain SMTP: the one picked (Server admin › Providers, or EMAIL_PROVIDER),
 * else the first in the registry with its fields set. null: plain SMTP (SMTP_URL) sends, or nothing is set up. A picked
 * service that is not set up gives null, as in every category: no silent switch to another one.
 */
export function mailServiceFromEnv(picked: string | null, env: Values): SmtpConnection | null {
  const order = picked ? providersIn('email').filter(p => p === picked) : providersIn('email')
  for (const provider of order) {
    if (provider === 'smtp') {
      if (env.SMTP_URL) return null
      continue
    }
    const smtp = smtpOf(provider, valuesFromEnv(provider, env))
    if (smtp || picked) return smtp
  }
  return null
}
