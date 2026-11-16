// "Find your business" (onboarding, first step): look the business up in Google Places (when the install has a key
// under Server admin › Providers › Business lookup), read its website, and propose a profile the owner reviews and
// edits. Nothing here saves anything: the step saves the reviewed profile with assistant.update (and businessHours.set
// once the owner confirms the hours). The industry templates are data: a few default use cases per trade.
import { z } from 'zod'
import { defineAction } from './define.ts'
import type { BusinessHoursSpan } from './settings.ts'

// --- Industry templates ---------------------------------------------------------------------

export const businessTemplateIds = [
  'plumbing_hvac',
  'dental_medical',
  'salon_spa',
  'law_office',
  'home_services',
  'other',
] as const
export type BusinessTemplateId = (typeof businessTemplateIds)[number]

export type BusinessTemplate = {
  label: string
  /** Google Places types (primaryType or types) that pick this template. */
  placesTypes: readonly string[]
  /** Words in the business name that pick it when Google gives no category. */
  nameWords: RegExp | null
  /** "When a caller …, …" lines the assistant starts from; the owner edits them in the review. */
  useCases: readonly string[]
}

/**
 * Every template starts with what is urgent for that trade. Emergencies (danger to people, fire, a break-in, a gas
 * smell) are not in them: every prompt tells the caller to contact the emergency services already (EMERGENCY_RULE). Whether an urgent call is put
 * through is up to Settings › Transfers, so the line only says to mark it urgent.
 */
const urgent = (when: string, take: string) => `When a caller ${when}, treat it as urgent: take ${take} and mark the message urgent.`

export const businessTemplates: Record<BusinessTemplateId, BusinessTemplate> = {
  plumbing_hvac: {
    label: 'Plumbing, heating and cooling',
    placesTypes: ['plumber', 'hvac_contractor', 'heating_contractor', 'air_conditioning_contractor'],
    nameWords: /plumb|heating|hvac|cooling|air condition|furnace|drain|rooter/i,
    useCases: [
      urgent('has a leak, flooding or no heat', 'their address and number'),
      "When a caller wants a repair or an estimate, ask what is wrong, their address and when they're home.",
      'When a caller asks about prices, give the prices you know and offer a callback for a quote otherwise.',
    ],
  },
  dental_medical: {
    label: 'Dental or medical office',
    placesTypes: [
      'dentist',
      'dental_clinic',
      'doctor',
      'medical_clinic',
      'physiotherapist',
      'chiropractor',
      'medical_lab',
    ],
    nameWords: /dental|dentist|orthodont|clinic|medical|family practice|pediatric|chiropract|physio/i,
    useCases: [
      urgent('has severe pain, swelling or a broken tooth', 'their name and number'),
      'When a caller wants an appointment, ask whether they are a new or existing patient and what it is for, and take their name and number.',
      'When a caller asks about insurance, take the plan name and offer a callback from the office; never ask for or repeat medical details beyond the reason for the visit.',
    ],
  },
  salon_spa: {
    label: 'Salon or spa',
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
    useCases: [
      urgent("can't make an appointment today", 'their name and the appointment time'),
      'When a caller wants to book, ask which service, which day and time suit them, and whether they have a favorite stylist.',
      'When a caller wants to cancel or move an appointment, take their name, the appointment time and a new time that suits them.',
    ],
  },
  law_office: {
    label: 'Law office',
    placesTypes: ['lawyer', 'legal_services', 'attorney'],
    nameWords: /\blaw\b|legal|attorney|lawyer|esq/i,
    useCases: [
      urgent('has a court deadline in the next few days', 'their name, number and the deadline'),
      'When a new client calls, ask what kind of matter it is and take their name and number for a callback; never give legal advice.',
      'When an existing client calls, take their name, their matter and their message for the attorney.',
    ],
  },
  home_services: {
    label: 'Home services',
    placesTypes: [
      'electrician',
      'roofing_contractor',
      'general_contractor',
      'locksmith',
      'painter',
      'moving_company',
      'landscaper',
      'pest_control_service',
      'house_cleaning_service',
    ],
    nameWords: /electric|roof|locksmith|paint|moving|movers|landscap|lawn|pest|cleaning|handyman|contractor|remodel/i,
    useCases: [
      urgent("has no power, water coming in or can't lock their door", 'their address and number'),
      "When a caller wants a job done or an estimate, ask what they need, their address and when they're available.",
      'When a caller asks about prices, give the prices you know and offer an estimate otherwise.',
    ],
  },
  other: {
    label: 'Something else',
    placesTypes: [],
    nameWords: null,
    useCases: [
      urgent("has something that can't wait", 'their name and number'),
      'When a caller wants to speak to someone, take their name, number and what it is about for a callback.',
      'When a caller asks about prices or opening hours, answer from what you know.',
    ],
  },
}

/**
 * The template for a business that was looked up: its Google category first, then words in its name; null when
 * neither tells (the owner chooses, "Something else" included).
 */
export function templateFor(business: {
  primaryType?: string | null
  types?: readonly string[]
  name?: string | null
}): BusinessTemplateId | null {
  const ids = businessTemplateIds.filter(id => id !== 'other')
  const byType = (type: string | null | undefined) =>
    type ? ids.find(id => businessTemplates[id].placesTypes.includes(type)) : undefined
  const typed = byType(business.primaryType) ?? business.types?.map(byType).find(Boolean)
  if (typed) return typed
  const name = business.name ?? ''
  return ids.find(id => businessTemplates[id].nameWords?.test(name)) ?? null
}

/** The greeting with the business's name, in the shape a new workspace starts with (apps/api/src/onboarding.ts). */
export const greetingFor = (business: string, assistant: string) =>
  `Thanks for calling ${business.trim()}. This is ${assistant.trim()}. How can I help?`

// --- Actions --------------------------------------------------------------------------------

export const BUSINESS_QUERY_MAX = 200
export const BUSINESS_NAME_MAX = 120 // the listing's name as given; the workspace name is checked on save
export const BUSINESS_SEARCH_RESULTS = 5
/** A Google place ID: letters, digits, - and _ (it goes into a URL path). */
const placeId = z.string().regex(/^[A-Za-z0-9_-]{10,300}$/, 'not a place ID')

/** One listing the owner can pick. */
export type BusinessCandidate = { placeId: string; name: string; address: string }
/**
 * A provider the step needed and could not use, in the provider-failure words (LIN-111): `config` not set up,
 * `auth` its key refused. Only whoever runs the server can fix either: admins under Server admin › Providers.
 */
export type BusinessLookupFailure = { provider: 'business' | 'llm'; reason: 'config' | 'auth' }

/**
 * `data` of `business.search`. `lookup` false: this install has no business lookup (or Google refused its key:
 * `failure`); the step asks for name and website.
 */
export type BusinessSearchData = { lookup: boolean; results: BusinessCandidate[]; failure?: BusinessLookupFailure }

export const businessSearch = defineAction({
  name: 'business.search',
  description:
    'Find the business in Google Places by name and city ("Brightwater Plumbing, Portland"): up to 5 listings with name and address. `lookup` is false when this install has no business lookup set up. Changes nothing.',
  input: z.object({ query: z.string().trim().min(2).max(BUSINESS_QUERY_MAX) }),
  permission: 'settings:write',
  readOnly: true,
})

/**
 * `data` of `business.import`: a profile proposal for the owner to review. Listing fields are null without a
 * listing; `hours` is null when Google has none or they cannot be written as weekly hours. `about`, `services`,
 * `area` and `useCases` come from the language model reading the listing and the website (empty without a model).
 */
export type BusinessImportData = {
  name: string
  address: string | null
  area: string | null
  /** As Google gives it, international ("+1 503-555-0142"). */
  phone: string | null
  website: string | null
  hours: BusinessHoursSpan[] | null
  /** Google's own week, one line per day ("Monday: 7:00 AM – 6:00 PM"). */
  hoursText: string[]
  /** The IANA zone of the listing. */
  timeZone: string | null
  /** Null when neither the listing nor the name tells the kind of business. */
  template: BusinessTemplateId | null
  services: string[]
  about: string
  useCases: string[]
  /** The assistant's greeting with the business's name. */
  greeting: string
  /** The website pages that were read. */
  pages: { url: string; title: string }[]
  /** What could not be used, in words for the owner ("The website could not be read: …"). */
  notes: string[]
  /**
   * Providers that were not set up or refused (no Places key: no listing; no language model: nothing written from
   * the website or listing). Not in `notes`: the step says who can fix it.
   */
  failures: BusinessLookupFailure[]
}

export const businessImport = defineAction({
  name: 'business.import',
  description:
    "Propose the business's profile for review: the Google Places listing (`placeId`, from business.search: address, phone, hours, website, category) and/or a `name` and `website`, then the website read like knowledge.import (robots.txt respected). Returns name, address, area, phone, hours, services, a short About text, use cases, a greeting and an industry template. Changes nothing: the owner reviews it and saves with assistant.update and businessHours.set.",
  input: z
    .object({
      assistantId: z.string().min(1),
      placeId: placeId.optional(),
      name: z.string().trim().max(BUSINESS_NAME_MAX).optional(),
      website: z.string().trim().max(2000).optional(),
    })
    .refine(i => i.placeId || i.name || i.website, { message: 'give the listing, the business name or its website' }),
  permission: 'settings:write',
  readOnly: true,
})
