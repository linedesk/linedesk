// Branding of the whole install (packages/actions/src/branding.ts): stored in instance_settings, the
// settings as JSON under `branding` and the logo (a PNG, base64) under `branding.logo`, so reading the
// settings never loads the image. Public: GET /v1/branding, the logo and the web app manifest.
//
// Emails, passkeys and messages read the name synchronously (brandName()): each API process keeps the
// settings in memory, loads them at start, after a change it made itself and every half minute (a
// second process during an update picks a change up within that time).
import { type Branding, type BrandingInput, DEFAULT_PRODUCT_NAME, LOGO_MAX_BYTES, LOGO_SIZE } from '@linedesk/actions'
import { type Db, instance_settings, type Tx } from '@linedesk/db'
import { eq, inArray } from 'drizzle-orm'
import { refreshStarCount, starCount } from './github-stars.ts'
import { type Handler, Reject } from './handler-context.ts'

const SETTINGS_KEY = 'branding'
const LOGO_KEY = 'branding.logo'
const REFRESH_MS = 30_000

type Stored = { name: string; color: string | null; starPrompt: boolean; logoVersion: string | null }
const DEFAULT_STORED: Stored = { name: DEFAULT_PRODUCT_NAME, color: null, starPrompt: true, logoVersion: null }

let current: Stored = DEFAULT_STORED

/** The product name people see: "Linedesk" unless an instance admin renamed it. */
export const brandName = () => current.name
/** Whether members may be asked for a GitHub star (star-prompt.ts). On unless an instance admin turned it off. */
export const starPromptAllowed = () => current.starPrompt

export const logoPath = (version: string) => `/v1/branding/logo.png?v=${encodeURIComponent(version)}`

const toBranding = (s: Stored): Branding => ({
  name: s.name,
  color: s.color,
  logoUrl: s.logoVersion ? logoPath(s.logoVersion) : null,
  starPrompt: s.starPrompt,
  starCount: s.starPrompt ? starCount() : null,
})

/** The branding in effect, as GET /v1/branding returns it. */
export const currentBranding = (): Branding => toBranding(current)

function parseStored(value: string | undefined): Stored {
  if (!value) return DEFAULT_STORED
  try {
    const parsed = JSON.parse(value) as Partial<Stored>
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : DEFAULT_PRODUCT_NAME,
      color: typeof parsed.color === 'string' ? parsed.color : null,
      starPrompt: parsed.starPrompt !== false,
      logoVersion: typeof parsed.logoVersion === 'string' ? parsed.logoVersion : null,
    }
  } catch {
    console.error('the stored branding cannot be read; using the defaults until an admin saves it again')
    return DEFAULT_STORED
  }
}

async function readStored(tx: Tx): Promise<Stored> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SETTINGS_KEY))
  return parseStored(row?.value)
}

/** Loads the stored branding into this process. */
export async function refreshBranding(db: Db): Promise<Branding> {
  current = await readStored(db)
  return currentBranding()
}

/** At start and every half minute; errors keep the last settings. The star count is read again when due. */
export function watchBranding(db: Db) {
  const load = () =>
    refreshBranding(db)
      .then(() => (current.starPrompt ? refreshStarCount() : undefined))
      .catch(error => console.error('could not load the branding:', error))
  void load()
  setInterval(load, REFRESH_MS).unref()
}

/** The logo's bytes, or null without one. */
export async function readLogo(tx: Tx): Promise<Buffer | null> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, LOGO_KEY))
  return row ? Buffer.from(row.value, 'base64') : null
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The PNG in a data URL, checked: a real PNG (signature and header), at most LOGO_SIZE square and LOGO_MAX_BYTES. */
export function decodeLogo(dataUrl: string): Buffer {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  if (bytes.length > LOGO_MAX_BYTES) throw new Reject(`The logo is too large: at most ${LOGO_MAX_BYTES / 1024} KB.`)
  const isPng =
    bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR'
  if (!isPng) throw new Reject('The logo must be a PNG image.')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height || width > LOGO_SIZE || height > LOGO_SIZE)
    throw new Reject(`The logo must be at most ${LOGO_SIZE}×${LOGO_SIZE} pixels.`)
  return bytes
}

async function upsert(tx: Tx, key: string, value: string, now: string, by: string) {
  await tx
    .insert(instance_settings)
    .values({ key, value, updated_at: now, updated_by: by })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: by } })
}

async function writeLogo(tx: Tx, logo: string | null | undefined, previous: string | null, now: string, by: string) {
  if (logo === undefined) return previous
  if (logo === null) {
    await tx.delete(instance_settings).where(eq(instance_settings.key, LOGO_KEY))
    return null
  }
  await upsert(tx, LOGO_KEY, decodeLogo(logo).toString('base64'), now, by)
  return crypto.randomUUID().slice(0, 8)
}

export const brandingHandlers: Record<string, Handler> = {
  'branding.set': async ({ tx, actor, now }, input: BrandingInput) => {
    const previous = await readStored(tx)
    const logoVersion = await writeLogo(tx, input.logo, previous.logoVersion, now, actor.actorId)
    const next: Stored = { name: input.name, color: input.color, starPrompt: input.starPrompt, logoVersion }
    await upsert(tx, SETTINGS_KEY, JSON.stringify(next), now, actor.actorId)
    current = next
    return { rows: {}, data: toBranding(next) satisfies Branding }
  },
}

/** Back to the defaults (tests). */
export async function resetBranding(tx: Tx) {
  await tx.delete(instance_settings).where(inArray(instance_settings.key, [SETTINGS_KEY, LOGO_KEY]))
  current = DEFAULT_STORED
}

/** The web app manifest with the install's name, color and logo (index.html links it). */
export function manifestFor(b: Branding = currentBranding()) {
  const icons = b.logoUrl
    ? [
        { src: b.logoUrl, sizes: `${LOGO_SIZE}x${LOGO_SIZE}`, type: 'image/png' },
        { src: b.logoUrl, sizes: `${LOGO_SIZE}x${LOGO_SIZE}`, type: 'image/png', purpose: 'maskable' },
      ]
    : [
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
  return {
    id: '/',
    name: b.name,
    short_name: b.name,
    description: 'Your phone front desk: calls answered, summarized and ready to act on.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fafaf8',
    theme_color: '#fafaf8',
    icons,
  }
}
