// Branding of the whole install (Admin, Branding): the product name, logo and primary color people see in
// the app, on the sign-in page, in the browser tab, on the installed app and in emails, and whether the
// GitHub star prompt shows. An install that keeps the defaults looks like Linedesk. Read by anyone
// (GET /v1/branding, before sign-in), changed only by instance admins.
import { z } from 'zod'
import { defineAction } from './define.ts'

export const DEFAULT_PRODUCT_NAME = 'Linedesk'
/** The logo is stored as a PNG made in the browser (at most LOGO_SIZE square), so no SVG with script is ever served. */
export const LOGO_SIZE = 512
export const LOGO_MAX_BYTES = 512 * 1024
const LOGO_PREFIX = 'data:image/png;base64,'

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #1c1917.')
  .transform(value => value.toLowerCase())

export const brandingInput = z.object({
  name: z.string().trim().min(1, 'Give the product a name.').max(40, 'At most 40 characters.'),
  /** Buttons and other primary actions. Null: the default (near-black). */
  color: hexColor.nullable(),
  /** A PNG as a data URL; null removes the logo; left out keeps the current one. */
  logo: z
    .string()
    .startsWith(LOGO_PREFIX, 'The logo must be a PNG.')
    .max(LOGO_PREFIX.length + Math.ceil(LOGO_MAX_BYTES / 3) * 4, 'The logo is too large.')
    .nullable()
    .optional(),
  /** The "Star on GitHub" prompt for members (on by default; apps/api/src/star-prompt.ts). */
  starPrompt: z.boolean(),
})
export type BrandingInput = z.infer<typeof brandingInput>

/**
 * What GET /v1/branding returns and `branding.set` answers with. `logoUrl` changes with every new logo.
 * `starCount`: the repository's GitHub stars as the server last read them (apps/api/src/github-stars.ts);
 * null while unknown or with the star prompt off.
 */
export type Branding = {
  name: string
  color: string | null
  logoUrl: string | null
  starPrompt: boolean
  starCount: number | null
}

export const DEFAULT_BRANDING: Branding = {
  name: DEFAULT_PRODUCT_NAME,
  color: null,
  logoUrl: null,
  starPrompt: true,
  starCount: null,
}

/** Near-white text on a dark color, near-black on a light one (WCAG relative luminance), for a #rrggbb color. */
export function readableOn(hex: string): string {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
  return luminance > 0.179 ? '#1c1917' : '#fafaf8'
}

export const brandingSet = defineAction({
  name: 'branding.set',
  description:
    'Set the branding of the whole install: product name, logo (a PNG data URL, null removes it, left out keeps it), primary color and whether the GitHub star prompt shows.',
  input: brandingInput,
  permission: 'instance:admin',
  // Not a secret, but up to half a megabyte: the command log notes that a logo was sent, not the image.
  sensitive: ['logo'],
})
