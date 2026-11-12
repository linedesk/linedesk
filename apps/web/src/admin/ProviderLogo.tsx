// What Admin, Providers shows for each provider besides its keys: a logo, one short line for its
// dialog, and where the provider hands out keys. Typed per provider, so a new entry in the registry
// needs one here too.
import type { ProviderName } from '@linedesk/actions'
import type { IconName } from '../ui/icons.ts'
import { cx, Icon } from '../ui/kit.tsx'
import { type BrandMark, brandMarks } from './logos.ts'

/** A brand mark from Simple Icons, or a neutral icon where there is none (Telnyx, Cartesia, Local disk). */
type Mark = { brand: BrandMark } | { icon: IconName }

type Meta = { mark: Mark; blurb: string; keysUrl?: string }

export const providerMeta: Record<ProviderName, Meta> = {
  telnyx: {
    mark: { icon: 'phone' },
    blurb: 'Phone numbers and calls.',
    keysUrl: 'https://portal.telnyx.com/#/api-keys',
  },
  twilio: { mark: { brand: 'twilio' }, blurb: 'Phone numbers and calls.', keysUrl: 'https://console.twilio.com/' },
  deepgram: {
    mark: { brand: 'deepgram' },
    blurb: 'Real-time speech recognition.',
    keysUrl: 'https://console.deepgram.com/',
  },
  openrouter: {
    mark: { brand: 'openrouter' },
    blurb: 'Many models behind one key.',
    keysUrl: 'https://openrouter.ai/settings/keys',
  },
  openai: {
    mark: { brand: 'openai' },
    blurb: 'GPT models from OpenAI.',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  elevenlabs: {
    mark: { brand: 'elevenlabs' },
    blurb: 'Natural voices.',
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  cartesia: { mark: { icon: 'waveform' }, blurb: 'Fast, expressive voices.', keysUrl: 'https://play.cartesia.ai/keys' },
  openai_realtime: {
    mark: { brand: 'openai' },
    blurb: 'Hears and speaks in one model.',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  file: { mark: { icon: 'disk' }, blurb: 'Recordings stay on this server.' },
  s3: { mark: { brand: 'amazons3' }, blurb: 'AWS S3, R2, Hetzner, Backblaze, MinIO.' },
  smtp: { mark: { icon: 'mail' }, blurb: 'Sign-in codes, invitations and call emails.' },
  resend: { mark: { brand: 'resend' }, blurb: 'Email with an API key.', keysUrl: 'https://resend.com/api-keys' },
  postmark: {
    mark: { icon: 'mail' },
    blurb: 'Email with a server token.',
    keysUrl: 'https://account.postmarkapp.com/servers',
  },
  sendgrid: {
    mark: { icon: 'mail' },
    blurb: 'Email with an API key.',
    keysUrl: 'https://app.sendgrid.com/settings/api_keys',
  },
  brevo: {
    mark: { brand: 'brevo' },
    blurb: 'Email with an SMTP key.',
    keysUrl: 'https://app.brevo.com/settings/keys/smtp',
  },
  mailgun: {
    mark: { brand: 'mailgun' },
    blurb: 'Email with SMTP credentials.',
    keysUrl: 'https://app.mailgun.com/mg/sending/domains',
  },
  gmail: {
    mark: { brand: 'gmail' },
    blurb: 'Email from a Gmail address.',
    keysUrl: 'https://myaccount.google.com/apppasswords',
  },
  google: {
    mark: { brand: 'google' },
    blurb: 'Sign in with Google and Google Calendar.',
    keysUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    mark: { brand: 'microsoft' },
    blurb: 'Sign in with Microsoft and Outlook calendars.',
    keysUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  github: {
    mark: { brand: 'github' },
    blurb: 'Sign in with GitHub.',
    keysUrl: 'https://github.com/settings/developers',
  },
  oidc: { mark: { icon: 'shield' }, blurb: 'Okta, Entra ID, Keycloak, Authentik and others.' },
}

/**
 * Where a provider sends people back after they sign in: the addresses to add to its OAuth app
 * (Better Auth's callbacks, and the calendar connection's: calendar-connections.ts).
 */
export function redirectUris(provider: ProviderName, origin: string): string[] {
  if (provider === 'google' || provider === 'microsoft')
    return [`${origin}/api/auth/callback/${provider}`, `${origin}/v1/calendar/callback/${provider}`]
  if (provider === 'github') return [`${origin}/api/auth/callback/github`]
  if (provider === 'oidc') return [`${origin}/api/auth/oauth2/callback/oidc`]
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
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
          <path d={brandMarks[mark.brand]} />
        </svg>
      ) : (
        <Icon name={mark.icon} size={glyph} />
      )}
    </span>
  )
}
