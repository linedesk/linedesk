// What Server admin › Providers shows for each provider besides its keys: a logo, one short line for its
// dialog, and where the provider hands out keys. Typed per provider, so a new entry in the registry
// needs one here too.
import type { ProviderName } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import type { IconName } from '../ui/icons.ts'
import { cx, Icon } from '../ui/kit.tsx'
import { type BrandMark, brandMarks, brandViewBox } from './logos.ts'

/** A brand mark from Simple Icons, or a neutral icon where there is none (Telnyx, Cartesia, Local disk). */
type Mark = { brand: BrandMark } | { icon: IconName }

/** `blurb`: the dialog's one line, a message key. */
type Meta = { mark: Mark; blurb: MessageKey; keysUrl?: string }

export const providerMeta: Record<ProviderName, Meta> = {
  telnyx: {
    mark: { icon: 'phone' },
    blurb: msg('admin.provider.blurb.phoneCarrier'),
    keysUrl: 'https://portal.telnyx.com/#/api-keys',
  },
  twilio: {
    mark: { brand: 'twilio' },
    blurb: msg('admin.provider.blurb.phoneCarrier'),
    keysUrl: 'https://console.twilio.com/',
  },
  deepgram: {
    mark: { brand: 'deepgram' },
    blurb: msg('admin.provider.blurb.deepgram'),
    keysUrl: 'https://console.deepgram.com/',
  },
  openrouter: {
    mark: { brand: 'openrouter' },
    blurb: msg('admin.provider.blurb.openrouter'),
    keysUrl: 'https://openrouter.ai/settings/keys',
  },
  openai: {
    mark: { brand: 'openai' },
    blurb: msg('admin.provider.blurb.openai'),
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    mark: { brand: 'anthropic' },
    blurb: msg('admin.provider.blurb.anthropic'),
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    mark: { brand: 'googlegemini' },
    blurb: msg('admin.provider.blurb.gemini'),
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  groq: { mark: { icon: 'spark' }, blurb: msg('admin.provider.blurb.groq'), keysUrl: 'https://console.groq.com/keys' },
  mistral: {
    mark: { brand: 'mistralai' },
    blurb: msg('admin.provider.blurb.mistral'),
    keysUrl: 'https://console.mistral.ai/api-keys',
  },
  elevenlabs_stt: {
    mark: { brand: 'elevenlabs' },
    blurb: msg('admin.provider.blurb.elevenlabs_stt'),
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  openai_stt: {
    mark: { brand: 'openai' },
    blurb: msg('admin.provider.blurb.openai_stt'),
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  assemblyai_stt: {
    mark: { icon: 'waveform' },
    blurb: msg('admin.provider.blurb.assemblyai_stt'),
    keysUrl: 'https://www.assemblyai.com/dashboard/api-keys',
  },
  openai_transcript: {
    mark: { brand: 'openai' },
    blurb: msg('admin.provider.blurb.openai_transcript'),
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  deepgram_transcript: {
    mark: { brand: 'deepgram' },
    blurb: msg('admin.provider.blurb.deepgram_transcript'),
    keysUrl: 'https://console.deepgram.com/',
  },
  assemblyai: {
    mark: { icon: 'waveform' },
    blurb: msg('admin.provider.blurb.assemblyai'),
    keysUrl: 'https://www.assemblyai.com/dashboard/api-keys',
  },
  elevenlabs_transcript: {
    mark: { brand: 'elevenlabs' },
    blurb: msg('admin.provider.blurb.elevenlabs_transcript'),
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  elevenlabs: {
    mark: { brand: 'elevenlabs' },
    blurb: msg('admin.provider.blurb.elevenlabs'),
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  cartesia: {
    mark: { icon: 'waveform' },
    blurb: msg('admin.provider.blurb.cartesia'),
    keysUrl: 'https://play.cartesia.ai/keys',
  },
  openai_realtime: {
    mark: { brand: 'openai' },
    blurb: msg('admin.provider.blurb.openai_realtime'),
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  file: { mark: { icon: 'disk' }, blurb: msg('admin.provider.blurb.file') },
  s3: { mark: { brand: 'amazons3' }, blurb: msg('admin.provider.blurb.s3') },
  smtp: { mark: { icon: 'mail' }, blurb: msg('admin.provider.blurb.smtp') },
  resend: {
    mark: { brand: 'resend' },
    blurb: msg('admin.provider.blurb.withApiKey'),
    keysUrl: 'https://resend.com/api-keys',
  },
  postmark: {
    mark: { icon: 'mail' },
    blurb: msg('admin.provider.blurb.postmark'),
    keysUrl: 'https://account.postmarkapp.com/servers',
  },
  sendgrid: {
    mark: { icon: 'mail' },
    blurb: msg('admin.provider.blurb.withApiKey'),
    keysUrl: 'https://app.sendgrid.com/settings/api_keys',
  },
  brevo: {
    mark: { brand: 'brevo' },
    blurb: msg('admin.provider.blurb.brevo'),
    keysUrl: 'https://app.brevo.com/settings/keys/smtp',
  },
  mailgun: {
    mark: { brand: 'mailgun' },
    blurb: msg('admin.provider.blurb.mailgun'),
    keysUrl: 'https://app.mailgun.com/mg/sending/domains',
  },
  gmail: {
    mark: { brand: 'gmail' },
    blurb: msg('admin.provider.blurb.gmail'),
    keysUrl: 'https://myaccount.google.com/apppasswords',
  },
  google_places: {
    mark: { brand: 'google' },
    blurb: msg('admin.provider.blurb.google_places'),
    keysUrl: 'https://console.cloud.google.com/google/maps-apis/credentials',
  },
  stripe: {
    mark: { icon: 'chart' },
    blurb: msg('admin.provider.blurb.stripe'),
    keysUrl: 'https://dashboard.stripe.com/apikeys',
  },
  cloudflare_saas: {
    mark: { brand: 'cloudflare' },
    blurb: msg('admin.provider.blurb.cloudflare_saas'),
    keysUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  turnstile: {
    mark: { icon: 'shield' },
    blurb: msg('admin.provider.blurb.turnstile'),
    keysUrl: 'https://dash.cloudflare.com/?to=/:account/turnstile',
  },
  google: {
    mark: { brand: 'google' },
    blurb: msg('admin.provider.blurb.google'),
    keysUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    mark: { brand: 'microsoft' },
    blurb: msg('admin.provider.blurb.microsoft'),
    keysUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  calendly: {
    mark: { brand: 'calendly' },
    blurb: msg('admin.provider.blurb.calendly'),
    keysUrl: 'https://calendly.com/app/developer',
  },
  calcom: {
    mark: { brand: 'caldotcom' },
    blurb: msg('admin.provider.blurb.calcom'),
    keysUrl: 'https://app.cal.com/settings/developer/oauth',
  },
  hubspot: {
    mark: { brand: 'hubspot' },
    blurb: msg('admin.provider.blurb.hubspot'),
    keysUrl: 'https://developers.hubspot.com/',
  },
  slack: {
    mark: { brand: 'slack' },
    blurb: msg('admin.provider.blurb.slack'),
    keysUrl: 'https://api.slack.com/apps',
  },
  // Simple Icons has no Jobber mark (logos.ts): a neutral icon, like the monogram on Integrations.
  jobber: {
    mark: { icon: 'users' },
    blurb: msg('admin.provider.blurb.jobber'),
    keysUrl: 'https://developer.getjobber.com/',
  },
  google_mail: {
    mark: { brand: 'gmail' },
    blurb: msg('admin.provider.blurb.google_mail'),
    keysUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  github: {
    mark: { brand: 'github' },
    blurb: msg('admin.provider.blurb.github'),
    keysUrl: 'https://github.com/settings/developers',
  },
  oidc: { mark: { icon: 'shield' }, blurb: msg('admin.provider.blurb.oidc') },
}

/**
 * Where a provider sends people back after they sign in: the addresses to add to its OAuth app
 * (Better Auth's callbacks, the calendar connection's: calendar-connections.ts, and the mailbox's: mail-connections.ts).
 */
export function redirectUris(provider: ProviderName, origin: string): string[] {
  if (provider === 'google') return [`${origin}/api/auth/callback/google`, `${origin}/v1/calendar/callback/google`]
  // Microsoft's app serves support mailboxes too (Mail.Read); Gmail's have an app of their own.
  if (provider === 'microsoft')
    return [
      `${origin}/api/auth/callback/microsoft`,
      `${origin}/v1/calendar/callback/microsoft`,
      `${origin}/v1/mail/callback/microsoft`,
    ]
  if (provider === 'google_mail') return [`${origin}/v1/mail/callback/google`]
  if (provider === 'github') return [`${origin}/api/auth/callback/github`]
  // Calendly allows exactly one redirect URI per app: the calendar one.
  if (provider === 'calendly' || provider === 'calcom') return [`${origin}/v1/calendar/callback/${provider}`]
  if (provider === 'oidc') return [`${origin}/api/auth/oauth2/callback/oidc`]
  if (provider === 'hubspot' || provider === 'slack' || provider === 'jobber')
    return [`${origin}/v1/apps/callback/${provider}`]
  return []
}

/** The S3 presets (registry, presets of `s3`) by label: their mark and where their access keys are made. */
export const presetMeta: Record<string, { mark: Mark; keysUrl?: string }> = {
  'AWS S3': { mark: { brand: 'amazons3' }, keysUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials' },
  'Cloudflare R2': {
    mark: { brand: 'cloudflare' },
    keysUrl: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
  },
  Hetzner: { mark: { brand: 'hetzner' }, keysUrl: 'https://console.hetzner.cloud/projects' },
  'Backblaze B2': { mark: { brand: 'backblaze' }, keysUrl: 'https://secure.backblaze.com/app_keys.htm' },
  MinIO: { mark: { brand: 'minio' } },
  'Amazon SES': { mark: { brand: 'amazons3' }, keysUrl: 'https://console.aws.amazon.com/ses/home#/smtp' },
}

export function Logo({ mark, size = 36 }: { mark: Mark; size?: 28 | 36 | 40 }) {
  const glyph = Math.round(size * 0.5)
  return (
    <span className={cx('adm-logo', `adm-logo-${size}`)} aria-hidden="true">
      {'brand' in mark ? (
        <svg
          width={glyph}
          height={glyph}
          viewBox={brandViewBox(mark.brand)}
          fill="currentColor"
          focusable="false"
          aria-hidden="true"
        >
          <path d={brandMarks[mark.brand]} />
        </svg>
      ) : (
        <Icon name={mark.icon} size={glyph} />
      )}
    </span>
  )
}
