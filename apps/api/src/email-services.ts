// Mail services with a key or an app password (Resend, Postmark, SendGrid, Brevo, Mailgun, Gmail) as the connection
// the API sends with. Their fields are stored like any provider's; at start (instance-env.ts) the one that sends
// becomes SMTP_URL and EMAIL_FROM. Every service but Resend is an SMTP URL; Resend's is its HTTPS API
// (https://resend:<key>@api.resend.com), which email.ts sends through on port 443, as many hosts block SMTP ports.
import { type ProviderName, providerSpec, providersIn } from '@linedesk/actions'

type Values = Record<string, string | undefined>
export type MailConnection = { url: string; from?: string }
export type MailService = 'resend' | 'postmark' | 'sendgrid' | 'brevo' | 'mailgun' | 'gmail'

const enc = (value: string) => encodeURIComponent(value.trim())

/**
 * The port rule for every SMTP preset: 587 with STARTTLS, and STARTTLS required (`requireTLS`, read by nodemailer from
 * the URL), so the key never goes out in clear text and a server that does not offer TLS is refused. 465 (implicit
 * TLS) is blocked outgoing on some hosts, Hetzner among them, and every preset service takes 587 with STARTTLS; some
 * (DigitalOcean, many clouds) block 587 too, where only Resend (HTTPS) gets through. Plain SMTP (Server admin ›
 * Providers › SMTP) keeps the URL the operator wrote.
 */
const STARTTLS_587 = '587?requireTLS=true'

/** Where Resend's API is: email.ts sends to it with the key from the connection URL (resendApiKeyOf). */
const RESEND_API_HOST = 'api.resend.com'

/** Each service's connection URL from its fields (in clear). Only called with every needed field set. */
const connectionUrls: Record<MailService, (v: Values) => string> = {
  resend: v => `https://resend:${enc(v.api_key!)}@${RESEND_API_HOST}`,
  postmark: v => `smtp://${enc(v.server_token!)}:${enc(v.server_token!)}@smtp.postmarkapp.com:${STARTTLS_587}`,
  sendgrid: v => `smtp://apikey:${enc(v.api_key!)}@smtp.sendgrid.net:${STARTTLS_587}`,
  brevo: v => `smtp://${enc(v.login!)}:${enc(v.smtp_key!)}@smtp-relay.brevo.com:${STARTTLS_587}`,
  mailgun: v =>
    `smtp://${enc(v.smtp_user!)}:${enc(v.smtp_password!)}@${v.region?.trim().toLowerCase() === 'eu' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org'}:${STARTTLS_587}`,
  // Google shows app passwords in groups of four: the spaces are not part of it.
  gmail: v => `smtp://${enc(v.address!)}:${enc(v.app_password!.replace(/\s+/g, ''))}@smtp.gmail.com:${STARTTLS_587}`,
}

export const isMailService = (provider: ProviderName): provider is MailService => provider in connectionUrls

/** A mail service's connection from its field values; null when it is not one or a needed field is empty. */
export function mailConnectionOf(provider: ProviderName, values: Values): MailConnection | null {
  if (!isMailService(provider)) return null
  const build = connectionUrls[provider]
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
export function mailServiceFromEnv(picked: string | null, env: Values): MailConnection | null {
  const order = picked ? providersIn('email').filter(p => p === picked) : providersIn('email')
  for (const provider of order) {
    if (provider === 'smtp') {
      if (env.SMTP_URL) return null
      continue
    }
    const connection = mailConnectionOf(provider, valuesFromEnv(provider, env))
    if (connection || picked) return connection
  }
  return null
}

/**
 * The Resend API key of a connection URL that is Resend's API (mailConnectionOf), else null: an smtp:// or smtps://
 * URL, the SMTP provider's included, always sends over SMTP.
 */
export function resendApiKeyOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== RESEND_API_HOST) return null
    return decodeURIComponent(parsed.password) || null
  } catch {
    return null
  }
}
