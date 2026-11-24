// What a partner's brand change touches that a server admin reviews (docs/white-label.md, S4): the name, the logo, the
// support email and the links. The color goes live without a review. Partner › Brand names the fields that wait;
// Server admin › Partners › Brands marks them.
import type { PartnerBrand } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'

export const REVIEWED_FIELDS = ['name', 'logo', 'supportEmail', 'termsUrl', 'privacyUrl'] as const
export type ReviewedField = (typeof REVIEWED_FIELDS)[number]

type Comparable = Pick<PartnerBrand, 'name' | 'logoUrl' | 'supportEmail' | 'termsUrl' | 'privacyUrl'>

const fieldValue = (brand: Comparable, field: ReviewedField) =>
  (field === 'logo' ? brand.logoUrl : brand[field]) ?? null

/** The reviewed fields in which `next` differs from `approved`; every field of `next` when nothing is approved yet. */
export function changedFields(next: Comparable, approved: Comparable | null): ReviewedField[] {
  if (!approved) return REVIEWED_FIELDS.filter(field => fieldValue(next, field) !== null)
  return REVIEWED_FIELDS.filter(field => fieldValue(next, field) !== fieldValue(approved, field))
}

/** The words for a field in "Waiting for review: support email". */
export const FIELD_KEY: Record<ReviewedField, MessageKey> = {
  name: msg('team.partner.brand.field.name'),
  logo: msg('team.partner.brand.field.logo'),
  supportEmail: msg('team.partner.brand.field.supportEmail'),
  termsUrl: msg('team.partner.brand.field.termsUrl'),
  privacyUrl: msg('team.partner.brand.field.privacyUrl'),
}
