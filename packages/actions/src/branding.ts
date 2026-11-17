// Branding of the whole install (Server admin › Branding): the product name, logo and primary color people see in
// the app, on the sign-in page, in the browser tab, on the installed app and in emails, and whether the
// GitHub star prompt shows. An install that keeps the defaults looks like Linedesk; one with its own name or
// logo shows a small "Powered by Linedesk" line in emails and on the sign-in page unless an admin hides it.
// Read by anyone (GET /v1/branding, before sign-in), changed only by instance admins.
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

/**
 * Characters a product name never has: control characters (newlines, tabs, escapes), line and paragraph separators,
 * format characters (the bidi overrides that reorder text, the soft hyphen, zero-width spaces and joiners) and every
 * other character that renders as nothing. The name goes into emails, the app and the Stripe products and invoice
 * lines (security review of #1040, I-2); an invisible character would also split a protected name so the check
 * misses it ("Cha\u00ADse" shows as Chase; security review of #1111, M-1).
 */
export const NAME_CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u

export const brandingInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the product a name.')
    .max(40, 'At most 40 characters.')
    .refine(
      name => !NAME_CONTROL_CHARACTERS.test(name),
      // i18n-ignore: the API's validation message for API clients; the web app checks first (admin.branding.nameCharacters)
      'Use letters, digits, spaces and punctuation only.',
    ),
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
  /** The "Powered by Linedesk" line under emails and the sign-in page (showsPoweredBy). Left out keeps the current setting. */
  poweredBy: z.boolean().optional(),
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
  /** The admin's switch; whether the line shows at all is showsPoweredBy(). */
  poweredBy: boolean
  /**
   * Set when this is a white-label partner's brand (a client workspace, docs/white-label.md, S4): its support email,
   * terms and privacy links replace the install's, and no "Powered by" line shows. Absent: the install's branding.
   */
  partner?: PartnerBrandLinks | null
}

/** A partner brand's links, shown to its clients instead of the install's (null: none set). */
export type PartnerBrandLinks = {
  id: string
  supportEmail: string | null
  terms: string | null
  privacy: string | null
}

export const DEFAULT_BRANDING: Branding = {
  name: DEFAULT_PRODUCT_NAME,
  color: null,
  logoUrl: null,
  starPrompt: true,
  starCount: null,
  poweredBy: true,
}

/** Where the "Powered by Linedesk" line links: the site, tagged with where it was seen (no install or person in it). */
export const poweredByUrl = (medium: 'email' | 'sign-in') =>
  `https://linedesk.ai/?utm_source=powered-by&utm_medium=${medium}`

/**
 * Whether emails and the sign-in page show "Powered by Linedesk": only with the install's own name or logo (the
 * default branding already shows Linedesk) and while the admin keeps the switch on. Never for a partner's brand: its
 * clients see no Linedesk (S4).
 */
export const showsPoweredBy = (b: Pick<Branding, 'name' | 'logoUrl' | 'poweredBy' | 'partner'>) =>
  !b.partner && b.poweredBy && (b.name !== DEFAULT_PRODUCT_NAME || b.logoUrl !== null)

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
    'Set the branding of the whole install: product name, logo (a PNG data URL, null removes it, left out keeps it), primary color, whether the GitHub star prompt shows and whether emails and the sign-in page say "Powered by Linedesk" (poweredBy, left out keeps it).',
  input: brandingInput,
  permission: 'instance:admin',
  // Not a secret, but up to half a megabyte: the command log notes that a logo was sent, not the image.
  sensitive: ['logo'],
})
