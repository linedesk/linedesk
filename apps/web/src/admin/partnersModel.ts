// What Server admin › Partners shows, kept out of the components so it can be tested: what waits for an instance
// admin (partners to approve and brands to review, one number on the "Waiting for approval" tab and in Overview ›
// Needs you), and which of a partner row's actions it offers.
import type { AdminPartner, PartnerBrandReview } from '@linedesk/actions'

/** Brands with a change no instance admin approved yet (never approved, or changed since). */
export const waitingBrands = <B extends Pick<PartnerBrandReview, 'state'>>(brands: readonly B[]) =>
  brands.filter(b => b.state !== 'approved')

/** Partners still to approve. */
export const waitingPartners = <P extends Pick<AdminPartner, 'status'>>(partners: readonly P[]) =>
  partners.filter(p => p.status === 'pending')

/** Everything that waits for an instance admin on the page: partners to approve plus brands to review. */
export const waitingCount = (
  partners: readonly Pick<AdminPartner, 'status'>[],
  brands: readonly Pick<PartnerBrandReview, 'state'>[],
) => waitingPartners(partners).length + waitingBrands(brands).length

/**
 * "Turn off AI keys" (or "Turn on AI keys" after it): only for a partner with a bill (own keys exist only on White-label
 * Cloud) that stored keys of its own, or whose keys an instance admin already turned off. A partner without keys has
 * nothing to turn off.
 */
export const offersKeysSwitch = (p: Pick<AdminPartner, 'billingAccountId' | 'ownKeys' | 'ownKeysDisabled'>) =>
  !!p.billingAccountId && (p.ownKeys > 0 || !!p.ownKeysDisabled)
