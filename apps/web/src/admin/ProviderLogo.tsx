// What Admin, Providers shows for each provider besides its keys: a logo, one short line for its
// dialog, and where the provider hands out keys. Typed per provider, so a new entry in the registry
// needs one here too.
import type { ProviderName } from '@callfront/actions'
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
  file: { mark: { icon: 'disk' }, blurb: 'Recordings stay on this server.' },
  s3: { mark: { brand: 'amazons3' }, blurb: 'AWS S3, R2, Hetzner, Backblaze, MinIO.' },
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
