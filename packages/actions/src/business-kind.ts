// The kind of business (LIN-680): one fixed list every workspace picks from in onboarding (found from the Google
// category, the website or the name; the owner confirms it) and can change in Workspace settings › General. Stored in
// workspace_settings.business_kind.
//
// A kind does two things. It picks the onboarding template (business.ts: the default common calls the assistant starts
// from; several kinds share one, so no text the assistant reads changes with a new kind). And it has traits, what the
// business does with its callers, which decide the go-live to-dos after onboarding (goLiveStepTraits in onboarding.ts):
// a step or an integration names the traits it is for, never the kinds, so a new kind or a new integration is one entry.
import type { BusinessTemplateId } from './business.ts'

/**
 * What a business does with its callers, as far as the setup cares:
 * - `appointments`: callers book a time (a calendar to book into).
 * - `site_visits`: the business goes out to the caller (jobs at an address; field-service software).
 * - `online_orders`: it sells through a shop system (orders, returns, shipping).
 * - `email_support`: customers also write in, so the mail tells what they ask (support mailbox, FAQ from it).
 */
export const businessTraits = ['appointments', 'site_visits', 'online_orders', 'email_support'] as const
export type BusinessTrait = (typeof businessTraits)[number]

/** The groups the kinds are listed in (onboarding's and the settings' pick list). */
export const businessKindGroups = [
  'trades',
  'health',
  'beauty_fitness',
  'professional',
  'auto',
  'food_stay',
  'retail',
  'education',
  'other',
] as const
export type BusinessKindGroup = (typeof businessKindGroups)[number]

export const businessKinds = [
  'plumbing_hvac',
  'electrical',
  'roofing_construction',
  'cleaning',
  'landscaping',
  'pest_control',
  'locksmith',
  'home_services',
  'dental',
  'medical',
  'therapy',
  'veterinary',
  'salon_spa',
  'fitness',
  'law_office',
  'accounting_tax',
  'insurance',
  'real_estate',
  'agency_consulting',
  'auto_repair',
  'restaurant',
  'hotel_lodging',
  'online_store',
  'retail_store',
  'education',
  'other',
] as const
export type BusinessKind = (typeof businessKinds)[number]

export const isBusinessKind = (value: unknown): value is BusinessKind =>
  typeof value === 'string' && (businessKinds as readonly string[]).includes(value)

export type BusinessKindInfo = {
  group: BusinessKindGroup
  /** The onboarding template whose default common calls it starts from. */
  template: BusinessTemplateId
  traits: readonly BusinessTrait[]
  /** Google Places types (primaryType or types) that pick it. */
  placesTypes: readonly string[]
  /** Words in the business name that pick it when Google gives no category. */
  nameWords: RegExp | null
}

const TRADE: readonly BusinessTrait[] = ['appointments', 'site_visits']
const OFFICE: readonly BusinessTrait[] = ['appointments', 'email_support']

export const businessKindInfo: Record<BusinessKind, BusinessKindInfo> = {
  plumbing_hvac: {
    group: 'trades',
    template: 'plumbing_hvac',
    traits: TRADE,
    placesTypes: ['plumber', 'hvac_contractor', 'heating_contractor', 'air_conditioning_contractor'],
    nameWords: /plumb|heating|hvac|cooling|air condition|furnace|drain|rooter/i,
  },
  electrical: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['electrician'],
    nameWords: /electric/i,
  },
  roofing_construction: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['roofing_contractor', 'general_contractor', 'painter', 'carpenter'],
    nameWords: /roof|contractor|remodel|construction|builders?\b|paint|carpent/i,
  },
  cleaning: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['house_cleaning_service', 'laundry', 'carpet_cleaning_service'],
    nameWords: /cleaning|cleaners|maids?\b|janitorial/i,
  },
  landscaping: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['landscaper', 'gardener', 'tree_service'],
    nameWords: /landscap|lawn|garden|tree service|yard/i,
  },
  pest_control: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['pest_control_service'],
    nameWords: /pest|exterminat|termite/i,
  },
  locksmith: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['locksmith'],
    nameWords: /locksmith|\blocks?\b/i,
  },
  home_services: {
    group: 'trades',
    template: 'home_services',
    traits: TRADE,
    placesTypes: ['moving_company'],
    nameWords: /moving|movers|handyman|home services?/i,
  },
  dental: {
    group: 'health',
    template: 'dental_medical',
    traits: ['appointments'],
    placesTypes: ['dentist', 'dental_clinic'],
    nameWords: /dental|dentist|orthodont/i,
  },
  medical: {
    group: 'health',
    template: 'dental_medical',
    traits: ['appointments'],
    placesTypes: ['doctor', 'medical_clinic', 'medical_lab', 'hospital', 'medical_center'],
    nameWords: /clinic|medical|family practice|pediatric|physicians?\b|health center/i,
  },
  therapy: {
    group: 'health',
    template: 'dental_medical',
    traits: ['appointments'],
    placesTypes: ['physiotherapist', 'chiropractor', 'psychologist', 'massage_therapist'],
    nameWords: /chiropract|physio|physical therapy|therapy|counseling|psycholog/i,
  },
  veterinary: {
    group: 'health',
    template: 'veterinary',
    traits: ['appointments'],
    placesTypes: ['veterinary_care', 'animal_hospital'],
    nameWords: /veterinar|\bvet\b|animal hospital|pet clinic/i,
  },
  salon_spa: {
    group: 'beauty_fitness',
    template: 'salon_spa',
    traits: ['appointments'],
    placesTypes: [
      'beauty_salon',
      'hair_salon',
      'hair_care',
      'nail_salon',
      'barber_shop',
      'spa',
      'massage',
      'beautician',
    ],
    nameWords: /salon|spa\b|barber|nails?\b|hair|beauty|massage|lash|brow/i,
  },
  fitness: {
    group: 'beauty_fitness',
    template: 'fitness',
    traits: ['appointments'],
    placesTypes: ['gym', 'fitness_center', 'yoga_studio', 'sports_club'],
    nameWords: /fitness|\bgym\b|yoga|pilates|crossfit|martial arts/i,
  },
  law_office: {
    group: 'professional',
    template: 'law_office',
    traits: OFFICE,
    placesTypes: ['lawyer', 'legal_services', 'attorney'],
    nameWords: /\blaw\b|legal|attorney|lawyer|esq/i,
  },
  accounting_tax: {
    group: 'professional',
    template: 'accounting_tax',
    traits: OFFICE,
    placesTypes: ['accounting', 'tax_preparation_service', 'tax_consultant'],
    nameWords: /accounting|accountants?\b|\bcpa\b|bookkeep|\btax\b/i,
  },
  insurance: {
    group: 'professional',
    template: 'insurance',
    traits: OFFICE,
    placesTypes: ['insurance_agency'],
    nameWords: /insurance|insurers?\b/i,
  },
  real_estate: {
    group: 'professional',
    template: 'real_estate',
    traits: OFFICE,
    placesTypes: ['real_estate_agency', 'property_management_company'],
    nameWords: /real estate|realty|realtors?\b|properties|property management/i,
  },
  agency_consulting: {
    group: 'professional',
    template: 'agency_consulting',
    traits: OFFICE,
    placesTypes: ['consultant', 'marketing_agency', 'advertising_agency', 'corporate_office'],
    nameWords: /consult|agency|marketing|advisors?\b/i,
  },
  auto_repair: {
    group: 'auto',
    template: 'auto_repair',
    traits: ['appointments'],
    placesTypes: ['car_repair', 'auto_body_shop', 'car_wash', 'tire_shop', 'car_dealer'],
    nameWords: /auto|motors|garage|tires?\b|body shop|car repair|mechanic/i,
  },
  restaurant: {
    group: 'food_stay',
    template: 'restaurant',
    traits: [],
    placesTypes: ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery', 'catering_service'],
    nameWords: /restaurant|cafe|café|bistro|pizz|grill|diner|kitchen|bakery|catering/i,
  },
  hotel_lodging: {
    group: 'food_stay',
    template: 'hotel_lodging',
    traits: ['email_support'],
    placesTypes: ['lodging', 'hotel', 'motel', 'bed_and_breakfast', 'guest_house', 'campground'],
    nameWords: /hotel|motel|\binn\b|lodge|b&b|bed and breakfast|hostel/i,
  },
  online_store: {
    group: 'retail',
    template: 'online_store',
    traits: ['online_orders', 'email_support'],
    placesTypes: [],
    nameWords: null,
  },
  retail_store: {
    group: 'retail',
    template: 'retail_store',
    traits: ['online_orders'],
    placesTypes: [
      'store',
      'clothing_store',
      'book_store',
      'electronics_store',
      'furniture_store',
      'home_goods_store',
      'jewelry_store',
      'shoe_store',
      'sporting_goods_store',
      'florist',
      'gift_shop',
      'pet_store',
    ],
    nameWords: /\bshop\b|store|boutique|bookshop|florist/i,
  },
  education: {
    group: 'education',
    template: 'education',
    traits: OFFICE,
    placesTypes: ['school', 'primary_school', 'secondary_school', 'preschool', 'university', 'driving_school'],
    nameWords: /school|academy|tutor|learning center|preschool|daycare/i,
  },
  other: {
    group: 'other',
    template: 'other',
    // What every business got before there were kinds: the calendar row.
    traits: ['appointments'],
    placesTypes: [],
    nameWords: null,
  },
}

/** The kinds of a group, in list order. */
export const kindsIn = (group: BusinessKindGroup): BusinessKind[] =>
  businessKinds.filter(k => businessKindInfo[k].group === group)

/**
 * A business's traits. A workspace without a kind (set up before kinds, or never picked) has the traits of `other`:
 * the go-live checklist it always had.
 */
export const traitsOf = (kind: BusinessKind | null | undefined): ReadonlySet<BusinessTrait> =>
  new Set(businessKindInfo[kind ?? 'other'].traits)

/**
 * The kind for a business that was looked up: its Google category first, then words in its name; null when neither
 * tells (the website, read by the language model, may still; else the owner chooses).
 */
export function kindFor(business: {
  primaryType?: string | null
  types?: readonly string[]
  name?: string | null
}): BusinessKind | null {
  const kinds = businessKinds.filter(k => k !== 'other')
  const byType = (type: string | null | undefined) =>
    type ? kinds.find(k => businessKindInfo[k].placesTypes.includes(type)) : undefined
  // The generic "store" only when no other type tells more (a pharmacy listed as a store too, say).
  const typed =
    byType(business.primaryType) ??
    business.types
      ?.filter(t => t !== 'store')
      .map(byType)
      .find(Boolean) ??
    (business.types?.includes('store') ? 'retail_store' : undefined)
  if (typed) return typed
  const name = business.name ?? ''
  return kinds.find(k => businessKindInfo[k].nameWords?.test(name)) ?? null
}

/** The template a kind starts from; null without a kind. */
export const templateOfKind = (kind: BusinessKind | null | undefined): BusinessTemplateId | null =>
  kind ? businessKindInfo[kind].template : null

/**
 * The kind a template stands for, where a template is all there is (an older API's proposal, a profile saved before
 * kinds): only a first guess the owner confirms. `other` stands for no kind in particular: the owner chooses.
 */
const kindOfTemplateId: Record<BusinessTemplateId, BusinessKind | null> = {
  plumbing_hvac: 'plumbing_hvac',
  dental_medical: 'medical',
  salon_spa: 'salon_spa',
  law_office: 'law_office',
  home_services: 'home_services',
  veterinary: 'veterinary',
  fitness: 'fitness',
  accounting_tax: 'accounting_tax',
  insurance: 'insurance',
  real_estate: 'real_estate',
  agency_consulting: 'agency_consulting',
  auto_repair: 'auto_repair',
  restaurant: 'restaurant',
  hotel_lodging: 'hotel_lodging',
  online_store: 'online_store',
  retail_store: 'retail_store',
  education: 'education',
  other: null,
}
export const kindOfTemplate = (template: BusinessTemplateId | null | undefined): BusinessKind | null =>
  template ? kindOfTemplateId[template] : null
