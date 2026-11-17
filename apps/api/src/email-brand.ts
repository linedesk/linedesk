// Whose brand an email carries (docs/white-label.md, S4). Templates (emails/layout.ts, emails/templates.ts) and the
// From line (email.ts) read the brand from here, synchronously: the install's branding (branding.ts), or, inside
// withEmailBrand, a white-label partner's. Code that sends a workspace's emails runs them inside
// withWorkspaceBrand (partner-brand.ts), which picks the workspace's partner brand once the partner may use it in
// emails. Billing emails to a partner's owner run outside any partner scope (Linedesk bills the partner).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Branding } from '@linedesk/actions'
import { currentBranding } from './branding.ts'

/** A brand for the emails sent inside withEmailBrand. */
export type EmailBrand = {
  /** As GET /v1/branding returns it; `partner` is set for a partner's brand. */
  branding: Branding
  /** Reply-To of every email in the scope: the partner's support email, else none. */
  replyTo: string | null
  /** Where links and the footer's site point: appOrigin(workspaceId) (partner-brand.ts). */
  origin: string
}

const scope = new AsyncLocalStorage<EmailBrand>()

/**
 * Runs `work` with `brand` for every email rendered and sent in it, also in what it starts without waiting. Null: the
 * install's brand, also inside a partner's scope.
 */
export function withEmailBrand<T>(brand: EmailBrand | null, work: () => T): T {
  return brand ? scope.run(brand, work) : scope.exit(work)
}

/**
 * Runs `work` with the install's brand, whatever scope it is started in: the install's own emails to its operators
 * (admin alerts) never go out under a partner's name or with its Reply-To, also when a workspace's email set them off
 * (a failed send alerts the admins; security review of #1111, L-1).
 */
export const withoutEmailBrand = <T>(work: () => T): T => scope.exit(work)

/** The branding emails show now: the scope's partner brand, else the install's. */
export const emailBranding = (): Branding => scope.getStore()?.branding ?? currentBranding()
/** The product name emails show now. */
export const emailBrandName = () => emailBranding().name
/** Whether the emails now carry a partner's brand (no "Powered by", the partner's name in the From line). */
export const partnerEmailBrand = () => !!scope.getStore()?.branding.partner
/** Reply-To of the emails now, or null. */
export const emailReplyTo = () => scope.getStore()?.replyTo ?? null
/** The app's address for links and the footer: the scope's (appOrigin), else WEB_ORIGIN. */
export const emailOrigin = () => scope.getStore()?.origin ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173'
