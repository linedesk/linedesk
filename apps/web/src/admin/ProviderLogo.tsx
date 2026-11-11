// What Admin, Providers shows for each provider besides its keys: a logo and one short line.
// Typed per provider, so a new entry in the registry needs one here too.
import type { ProviderCategory, ProviderName } from '@callfront/actions'
import { cx, Icon } from '../ui/kit.tsx'
import { type BrandMark, brandMarks } from './logos.ts'

type Mark = { brand: BrandMark } | { icon: 'disk' } | { monogram: string }

export const providerMeta: Record<ProviderName, { mark: Mark; blurb: string }> = {
  telnyx: { mark: { monogram: 'T' }, blurb: 'Phone numbers and calls. The default carrier.' },
  twilio: { mark: { brand: 'twilio' }, blurb: 'Phone numbers and calls.' },
  deepgram: { mark: { brand: 'deepgram' }, blurb: 'Real-time speech recognition.' },
  openrouter: { mark: { brand: 'openrouter' }, blurb: 'Many models behind one key.' },
  openai: { mark: { brand: 'openai' }, blurb: 'GPT models, straight from OpenAI.' },
  elevenlabs: { mark: { brand: 'elevenlabs' }, blurb: 'Natural voices with low latency.' },
  cartesia: { mark: { monogram: 'C' }, blurb: 'Fast, expressive voices.' },
  file: { mark: { icon: 'disk' }, blurb: 'Recordings stay on this server.' },
  s3: { mark: { brand: 'amazons3' }, blurb: 'AWS S3, R2, Hetzner, Backblaze, MinIO.' },
}

/** One line per category, under its title. */
export const categoryBlurb: Record<ProviderCategory, string> = {
  telephony: 'Phone numbers and calls.',
  stt: "Turns the caller's words into text.",
  llm: 'Understands the call and writes the replies.',
  tts: "Speaks the assistant's replies.",
  recording: 'Where call recordings are kept.',
}

/** The S3 presets' marks, by preset label (registry, presets of `s3`). */
export const presetMarks: Record<string, Mark> = {
  'AWS S3': { brand: 'amazons3' },
  'Cloudflare R2': { brand: 'cloudflare' },
  Hetzner: { brand: 'hetzner' },
  'Backblaze B2': { brand: 'backblaze' },
  MinIO: { brand: 'minio' },
}

export function Logo({ mark, size = 36 }: { mark: Mark; size?: 28 | 36 | 40 }) {
  const glyph = Math.round(size * 0.5)
  return (
    <span className={cx('adm-logo', `adm-logo-${size}`, 'monogram' in mark && 'adm-logo-mono')} aria-hidden="true">
      {'brand' in mark ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
          <path d={brandMarks[mark.brand]} />
        </svg>
      ) : 'icon' in mark ? (
        <Icon name={mark.icon} size={glyph} />
      ) : (
        mark.monogram
      )}
    </span>
  )
}
