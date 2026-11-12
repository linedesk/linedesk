// Mail services with a key or an app password (Resend, Postmark, SendGrid, Brevo, Mailgun, Gmail) as the SMTP
// connection the API sends with. Their fields are stored like any provider's; at start (instance-env.ts) the one
// that sends becomes SMTP_URL and EMAIL_FROM, so the mail transport (email.ts) stays plain SMTP.
import { type ProviderName, providerSpec, providersIn } from '@linedesk/actions'

type Values = Record<string, string | undefined>
export type SmtpConnection = { url: string; from?: string }
export type MailService = 'resend' | 'postmark' | 'sendgrid' | 'brevo' | 'mailgun' | 'gmail'

const enc = (value: string) => encodeURIComponent(value.trim())

/** Each service's SMTP URL from its fields (in clear). Only called with every needed field set. */
const smtpUrls: Record<MailService, (v: Values) => string> = {
  resend: v => `smtps://resend:${enc(v.api_key!)}@smtp.resend.com:465`,
  postmark: v => `smtp://${enc(v.server_token!)}:${enc(v.server_token!)}@smtp.postmarkapp.com:587`,
  sendgrid: v => `smtps://apikey:${enc(v.api_key!)}@smtp.sendgrid.net:465`,
  brevo: v => `smtp://${enc(v.login!)}:${enc(v.smtp_key!)}@smtp-relay.brevo.com:587`,
  mailgun: v =>
    `smtps://${enc(v.smtp_user!)}:${enc(v.smtp_password!)}@${v.region?.trim().toLowerCase() === 'eu' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org'}:465`,
  // Google shows app passwords in groups of four: the spaces are not part of it.
  gmail: v => `smtps://${enc(v.address!)}:${enc(v.app_password!.replace(/\s+/g, ''))}@smtp.gmail.com:465`,
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
 * The mail service that sends, when it is not plain SMTP: the one picked (Admin, Providers, or EMAIL_PROVIDER), else
 * the first in the registry with its fields set. null: plain SMTP (SMTP_URL) sends, or nothing is set up. A picked
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
