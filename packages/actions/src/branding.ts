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
  /** The "Star on GitHub" prompt for members (also needs STAR_PROMPT_REPO on the server). */
  starPrompt: z.boolean(),
})
export type BrandingInput = z.infer<typeof brandingInput>

/** What GET /v1/branding returns and `branding.set` answers with. `logoUrl` changes with every new logo. */
export type Branding = { name: string; color: string | null; logoUrl: string | null; starPrompt: boolean }

export const DEFAULT_BRANDING: Branding = { name: DEFAULT_PRODUCT_NAME, color: null, logoUrl: null, starPrompt: true }

export const brandingSet = defineAction({
  name: 'branding.set',
  description:
    'Set the branding of the whole install: product name, logo (a PNG data URL, null removes it, left out keeps it), primary color and whether the GitHub star prompt shows.',
  input: brandingInput,
  permission: 'instance:admin',
  // Not a secret, but up to half a megabyte: the command log notes that a logo was sent, not the image.
  sensitive: ['logo'],
})
