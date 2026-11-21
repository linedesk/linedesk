// "Find your business" (onboarding, first step): look the business up in Google Places (when the install has a key
// under Server admin › Providers › Business lookup), read its website, and propose a profile the owner reviews and
// edits. Nothing here saves anything: the step saves the reviewed profile with assistant.update (and businessHours.set
// once the owner confirms the hours). The industry templates are data: a few default use cases per trade.
import { z } from 'zod'
import { type BusinessKind, kindFor, templateOfKind } from './business-kind.ts'
import { DEFAULT_AI_DISCLOSURE, greetingWithDisclosure } from './assistant-prompt.ts'
import { defineAction } from './define.ts'
import { voiceLanguageOf } from './workspace-locale.ts'
import { spokenLines } from './spoken-lines.ts'
import type { BusinessHoursSpan } from './settings.ts'

// --- Industry templates ---------------------------------------------------------------------

export const businessTemplateIds = [
  'plumbing_hvac',
  'dental_medical',
  'salon_spa',
  'law_office',
  'home_services',
  'veterinary',
  'fitness',
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
export type BusinessTemplateId = (typeof businessTemplateIds)[number]

export type BusinessTemplate = {
  label: string
  /** "When a caller …, …" lines the assistant starts from; the owner edits them in the review. */
  useCases: readonly string[]
}

/**
 * Every template starts with what is urgent for that trade. Emergencies (danger to people, fire, a break-in, a gas
 * smell) are not in them: every prompt tells the caller to contact the emergency services already (EMERGENCY_RULE). Whether an urgent call is put
 * through is up to Settings › Transfers, so the line only says to mark it urgent.
 */
const urgent = (when: string, take: string) =>
  `When a caller ${when}, treat it as urgent: take ${take} and mark the message urgent.`

// i18n-ignore: text the assistant reads, not UI (rule 11; the labels are not shown, the app names kinds from common.json)
export const businessTemplates: Record<BusinessTemplateId, BusinessTemplate> = {
  plumbing_hvac: {
    label: 'Plumbing, heating and cooling',
    useCases: [
      urgent('has a leak, flooding or no heat', 'their address and number'),
      "When a caller wants a repair or an estimate, ask what is wrong, their address and when they're home.",
      'When a caller asks about prices, give the prices you know and offer a callback for a quote otherwise.',
    ],
  },
  dental_medical: {
    label: 'Dental or medical office',
    useCases: [
      urgent('has severe pain, swelling or a broken tooth', 'their name and number'),
      'When a caller wants an appointment, ask whether they are a new or existing patient and what it is for, and take their name and number.',
      'When a caller asks about insurance, take the plan name and offer a callback from the office; never ask for or repeat medical details beyond the reason for the visit.',
    ],
  },
  salon_spa: {
    label: 'Salon or spa',
    useCases: [
      urgent("can't make an appointment today", 'their name and the appointment time'),
      'When a caller wants to book, ask which service, which day and time suit them, and whether they have a favorite stylist.',
      'When a caller wants to cancel or move an appointment, take their name, the appointment time and a new time that suits them.',
    ],
  },
  law_office: {
    label: 'Law office',
    useCases: [
      urgent('has a court deadline in the next few days', 'their name, number and the deadline'),
      'When a new client calls, ask what kind of matter it is and take their name and number for a callback; never give legal advice.',
      'When an existing client calls, take their name, their matter and their message for the attorney.',
    ],
  },
  home_services: {
    label: 'Home services',
    useCases: [
      urgent("has no power, water coming in or can't lock their door", 'their address and number'),
      "When a caller wants a job done or an estimate, ask what they need, their address and when they're available.",
      'When a caller asks about prices, give the prices you know and offer an estimate otherwise.',
    ],
  },
  veterinary: {
    label: 'Veterinary clinic',
    useCases: [
      urgent("says their pet is badly hurt, poisoned or can't breathe", 'their name, number and what happened'),
      "When a caller wants an appointment, ask for the pet's name, what kind of animal it is and what the visit is for, and take their name and number.",
      'When a caller asks about prices or vaccinations, give the prices you know and offer a callback from the clinic otherwise.',
    ],
  },
  fitness: {
    label: 'Gym or fitness studio',
    useCases: [
      urgent("can't make a class or session booked for today", 'their name and the time of the class'),
      'When a caller asks about memberships or prices, give the prices you know and offer a trial session or a callback otherwise.',
      'When a caller wants to book, cancel or move a class or session, take their name, the class and a time that suits them.',
    ],
  },
  accounting_tax: {
    label: 'Accounting or tax',
    useCases: [
      urgent(
        'has a tax deadline or a letter from the tax office due in the next few days',
        'their name, number and the deadline',
      ),
      'When a new client calls, ask what they need help with (taxes, bookkeeping or payroll) and take their name and number for a callback; never give tax advice.',
      'When an existing client calls, take their name and their message for their accountant.',
    ],
  },
  insurance: {
    label: 'Insurance agency',
    useCases: [
      urgent(
        'has just had an accident, a break-in or damage to their home',
        'their name, number, policy number if they have it and what happened',
      ),
      'When a caller wants a quote, ask what they want to insure and take their name and number for a callback; never promise a price or cover.',
      'When an existing client calls about their policy or a claim, take their name, policy number and their message for their agent.',
    ],
  },
  real_estate: {
    label: 'Real estate',
    useCases: [
      urgent('is a tenant with a leak, no heat or a broken lock', 'their name, the address and their number'),
      'When a caller asks about a listing, ask which property it is and whether they want to buy or rent, and take their name and number for a callback or a viewing.',
      'When a caller wants to sell or rent out a property, take its address and their name and number for a callback.',
    ],
  },
  agency_consulting: {
    label: 'Agency or consulting',
    useCases: [
      urgent("says a project or campaign of theirs has a problem that can't wait", 'their name, company and number'),
      'When a new client calls, ask what they need help with and take their name, company and number for a callback.',
      'When an existing client calls, take their name, company and their message for their contact person.',
    ],
  },
  auto_repair: {
    label: 'Auto repair or dealer',
    useCases: [
      urgent("has broken down or can't drive their car safely", 'their name, number and where the car is'),
      "When a caller wants a repair or a service, ask for the car's make, model and year, what is wrong and when they can bring it in.",
      'When a caller asks whether their car is ready, take their name and number and offer a callback from the shop.',
    ],
  },
  restaurant: {
    label: 'Restaurant or café',
    useCases: [
      urgent('wants to change or cancel a reservation for today', 'their name, the time and the number of guests'),
      'When a caller wants a table, ask for the day, the time and the number of guests, and take their name and number.',
      "When a caller asks about the menu, opening hours or allergies, answer from what you know and offer a callback for anything you don't know.",
    ],
  },
  hotel_lodging: {
    label: 'Hotel or lodging',
    useCases: [
      urgent(
        'is a guest on the way or staying with you and has a problem with their stay',
        'their name, room or booking and number',
      ),
      "When a caller wants to book, ask for the dates and the number of guests and take their name and number; never confirm a room you can't see as free.",
      'When a caller asks about check-in times, parking or breakfast, answer from what you know.',
    ],
  },
  online_store: {
    label: 'Online store',
    useCases: [
      urgent(
        'was charged but got no order confirmation, or got a damaged or wrong item',
        'their name, order number and number',
      ),
      'When a caller asks where their order is, ask for the order number or the email they ordered with, and tell them what you know about it.',
      'When a caller wants to return or exchange something, take their name, order number and the reason, and tell them the return policy you know.',
    ],
  },
  retail_store: {
    label: 'Shop or retail store',
    useCases: [
      urgent("needs an item today for something that can't wait", 'their name, number and the item'),
      'When a caller asks whether something is in stock, answer if you know; otherwise take the item and their name and number for a callback.',
      'When a caller asks about opening hours, returns or how to get there, answer from what you know.',
    ],
  },
  education: {
    label: 'School or tutoring',
    useCases: [
      urgent(
        "says a child can't be picked up or isn't where they should be",
        "their name, number and the child's name",
      ),
      'When a caller asks about enrolment, classes or prices, ask who it is for and what they are looking for, and take their name and number for a callback.',
      "When a parent or student calls about an absence or a change, take the student's name, the date and the reason.",
    ],
  },
  other: {
    label: 'Something else',
    useCases: [
      urgent("has something that can't wait", 'their name and number'),
      'When a caller wants to speak to someone, take their name, number and what it is about for a callback.',
      'When a caller asks about prices or opening hours, answer from what you know.',
    ],
  },
}

// --- German texts ----------------------------------------------------------------------------
// Text the assistant reads, not UI (CLAUDE.md rule 11): this wording was approved by Janik on 2026-11-20. Kept here
// like the spoken lines (spoken-lines.ts), not in the i18n files. Only German for now; every other language gets the
// English texts above.

/** The languages with their own About labels and common-calls templates; every other gets English. */
export type AboutLanguage = 'en' | 'de'
export const aboutLanguageOf = (language: string | null | undefined): AboutLanguage => (language === 'de' ? 'de' : 'en')

// i18n-ignore: text the assistant reads, not UI (rule 11; wording approved by Janik on 2026-11-20)
const urgentDe = (when: string, take: string) =>
  `Wenn jemand anruft und ${when}, behandle es als dringend: nimm ${take} auf und markiere die Nachricht als dringend.`

// i18n-ignore: text the assistant reads, not UI (rule 11; wording approved by Janik on 2026-11-20)
const germanUseCases: Record<BusinessTemplateId, readonly string[]> = {
  plumbing_hvac: [
    urgentDe('einen Wasserschaden, eine Überschwemmung oder keine Heizung hat', 'Adresse und Telefonnummer'),
    'Wenn jemand eine Reparatur oder einen Kostenvoranschlag möchte, frag, was nicht funktioniert, nach der Adresse und wann die Person zu Hause ist.',
    'Wenn jemand nach Preisen fragt, nenne die Preise, die du kennst, und biete sonst einen Rückruf für ein Angebot an.',
  ],
  dental_medical: [
    urgentDe('starke Schmerzen, eine Schwellung oder einen abgebrochenen Zahn hat', 'Name und Telefonnummer'),
    'Wenn jemand einen Termin möchte, frag, ob die Person neu ist oder schon in der Praxis war und worum es geht, und nimm Name und Telefonnummer auf.',
    'Wenn jemand nach der Versicherung fragt, nimm die Versicherung auf und biete einen Rückruf der Praxis an. Frag nie nach medizinischen Details über den Grund des Besuchs hinaus und wiederhole keine.',
  ],
  salon_spa: [
    urgentDe('einen Termin heute nicht wahrnehmen kann', 'Name und Uhrzeit des Termins'),
    'Wenn jemand buchen möchte, frag nach der Leistung, welcher Tag und welche Uhrzeit passen und ob es eine Wunsch-Stylistin oder einen Wunsch-Stylisten gibt.',
    'Wenn jemand einen Termin absagen oder verschieben möchte, nimm Name, Termin und eine neue passende Zeit auf.',
  ],
  law_office: [
    urgentDe('in den nächsten Tagen eine Gerichtsfrist hat', 'Name, Telefonnummer und die Frist'),
    'Wenn neue Mandanten anrufen, frag, um welche Art von Angelegenheit es geht, und nimm Name und Telefonnummer für einen Rückruf auf. Gib nie Rechtsberatung.',
    'Wenn bestehende Mandanten anrufen, nimm Name, Angelegenheit und die Nachricht für die Anwältin oder den Anwalt auf.',
  ],
  home_services: [
    urgentDe('keinen Strom hat, Wasser eindringt oder die Tür nicht abschließen kann', 'Adresse und Telefonnummer'),
    'Wenn jemand einen Auftrag oder einen Kostenvoranschlag möchte, frag, was gebraucht wird, nach der Adresse und wann die Person Zeit hat.',
    'Wenn jemand nach Preisen fragt, nenne die Preise, die du kennst, und biete sonst einen Kostenvoranschlag an.',
  ],
  veterinary: [
    urgentDe(
      'sagt, dass das Tier schwer verletzt ist, etwas Giftiges gefressen hat oder schlecht Luft bekommt',
      'Name, Telefonnummer und was passiert ist',
    ),
    'Wenn jemand einen Termin möchte, frag nach dem Namen des Tiers, um welches Tier es geht und worum es beim Besuch geht, und nimm Name und Telefonnummer auf.',
    'Wenn jemand nach Preisen oder Impfungen fragt, nenne die Preise, die du kennst, und biete sonst einen Rückruf der Praxis an.',
  ],
  fitness: [
    urgentDe('einen Kurs oder Termin heute nicht wahrnehmen kann', 'Name und Uhrzeit des Kurses'),
    'Wenn jemand nach Mitgliedschaften oder Preisen fragt, nenne die Preise, die du kennst, und biete sonst ein Probetraining oder einen Rückruf an.',
    'Wenn jemand einen Kurs oder Termin buchen, absagen oder verschieben möchte, nimm Name, Kurs und eine passende Zeit auf.',
  ],
  accounting_tax: [
    urgentDe(
      'in den nächsten Tagen eine Steuerfrist oder einen Brief vom Finanzamt mit Frist hat',
      'Name, Telefonnummer und die Frist',
    ),
    'Wenn neue Mandanten anrufen, frag, wobei sie Hilfe brauchen (Steuern, Buchhaltung oder Lohn), und nimm Name und Telefonnummer für einen Rückruf auf. Gib nie Steuerberatung.',
    'Wenn bestehende Mandanten anrufen, nimm Name und die Nachricht für ihre Beraterin oder ihren Berater auf.',
  ],
  insurance: [
    urgentDe(
      'gerade einen Unfall, einen Einbruch oder einen Schaden am Haus hatte',
      'Name, Telefonnummer, Versicherungsnummer, falls zur Hand, und was passiert ist',
    ),
    'Wenn jemand ein Angebot möchte, frag, was versichert werden soll, und nimm Name und Telefonnummer für einen Rückruf auf. Versprich nie einen Preis oder einen Versicherungsschutz.',
    'Wenn bestehende Kunden wegen ihres Vertrags oder eines Schadens anrufen, nimm Name, Versicherungsnummer und die Nachricht für ihre Betreuerin oder ihren Betreuer auf.',
  ],
  real_estate: [
    urgentDe(
      'als Mieterin oder Mieter einen Wasserschaden, keine Heizung oder ein kaputtes Schloss hat',
      'Name, Adresse und Telefonnummer',
    ),
    'Wenn jemand nach einem Objekt fragt, frag, um welches es geht und ob die Person kaufen oder mieten möchte, und nimm Name und Telefonnummer für einen Rückruf oder eine Besichtigung auf.',
    'Wenn jemand eine Immobilie verkaufen oder vermieten möchte, nimm die Adresse sowie Name und Telefonnummer für einen Rückruf auf.',
  ],
  agency_consulting: [
    urgentDe(
      'sagt, dass ein Projekt oder eine Kampagne ein Problem hat, das nicht warten kann',
      'Name, Firma und Telefonnummer',
    ),
    'Wenn neue Kunden anrufen, frag, wobei sie Hilfe brauchen, und nimm Name, Firma und Telefonnummer für einen Rückruf auf.',
    'Wenn bestehende Kunden anrufen, nimm Name, Firma und die Nachricht für ihre Ansprechperson auf.',
  ],
  auto_repair: [
    urgentDe(
      'eine Panne hat oder mit dem Auto nicht mehr sicher fahren kann',
      'Name, Telefonnummer und wo das Auto steht',
    ),
    'Wenn jemand eine Reparatur oder einen Service möchte, frag nach Marke, Modell und Baujahr, was nicht funktioniert und wann die Person das Auto bringen kann.',
    'Wenn jemand fragt, ob das Auto fertig ist, nimm Name und Telefonnummer auf und biete einen Rückruf der Werkstatt an.',
  ],
  restaurant: [
    urgentDe('eine Reservierung für heute ändern oder absagen möchte', 'Name, Uhrzeit und Anzahl der Gäste'),
    'Wenn jemand einen Tisch möchte, frag nach Tag, Uhrzeit und Anzahl der Gäste, und nimm Name und Telefonnummer auf.',
    'Wenn jemand nach der Speisekarte, den Öffnungszeiten oder Allergien fragt, antworte mit dem, was du weißt, und biete für alles andere einen Rückruf an.',
  ],
  hotel_lodging: [
    urgentDe(
      'als Gast unterwegs ist oder bei euch wohnt und ein Problem mit dem Aufenthalt hat',
      'Name, Zimmer oder Buchung und Telefonnummer',
    ),
    'Wenn jemand buchen möchte, frag nach den Daten und der Anzahl der Gäste und nimm Name und Telefonnummer auf. Bestätige nie ein Zimmer, von dem du nicht siehst, dass es frei ist.',
    'Wenn jemand nach Check-in-Zeiten, Parkplätzen oder Frühstück fragt, antworte mit dem, was du weißt.',
  ],
  online_store: [
    urgentDe(
      'bezahlt, aber keine Bestellbestätigung bekommen hat, oder einen beschädigten oder falschen Artikel bekommen hat',
      'Name, Bestellnummer und Telefonnummer',
    ),
    'Wenn jemand fragt, wo die Bestellung ist, frag nach der Bestellnummer oder der E-Mail-Adresse der Bestellung und sag, was du darüber weißt.',
    'Wenn jemand etwas zurückgeben oder umtauschen möchte, nimm Name, Bestellnummer und den Grund auf und nenne die Rückgaberegeln, die du kennst.',
  ],
  retail_store: [
    urgentDe('heute einen Artikel für etwas braucht, das nicht warten kann', 'Name, Telefonnummer und den Artikel'),
    'Wenn jemand fragt, ob etwas vorrätig ist, antworte, wenn du es weißt; sonst nimm den Artikel sowie Name und Telefonnummer für einen Rückruf auf.',
    'Wenn jemand nach Öffnungszeiten, Rückgabe oder dem Weg fragt, antworte mit dem, was du weißt.',
  ],
  education: [
    urgentDe(
      'sagt, dass ein Kind nicht abgeholt werden kann oder nicht da ist, wo es sein sollte',
      'Name, Telefonnummer und den Namen des Kindes',
    ),
    'Wenn jemand nach Anmeldung, Kursen oder Preisen fragt, frag, für wen es ist und was gesucht wird, und nimm Name und Telefonnummer für einen Rückruf auf.',
    'Wenn Eltern oder Schüler wegen einer Abwesenheit oder einer Änderung anrufen, nimm den Namen der Schülerin oder des Schülers, das Datum und den Grund auf.',
  ],
  other: [
    urgentDe('etwas hat, das nicht warten kann', 'Name und Telefonnummer'),
    'Wenn jemand mit einer Person sprechen möchte, nimm Name, Telefonnummer und das Anliegen für einen Rückruf auf.',
    'Wenn jemand nach Preisen oder Öffnungszeiten fragt, antworte mit dem, was du weißt.',
  ],
}

/** A template's default use cases in a workspace language (German, else English). */
export const templateUseCasesIn = (id: BusinessTemplateId, language: string | null | undefined): readonly string[] =>
  aboutLanguageOf(language) === 'de' ? germanUseCases[id] : businessTemplates[id].useCases

/** A template's default use cases in every language that has its own: to find them in a saved text, whichever it is. */
export const templateUseCasesAnyLanguage = (id: BusinessTemplateId): readonly string[] => [
  ...businessTemplates[id].useCases,
  ...germanUseCases[id],
]

/** The labels of the About text (onboarding's instructionsOf, Write with help): what the assistant reads. */
export type AboutLabels = { services: string; area: string; address: string; commonCalls: string }
// i18n-ignore: text the assistant reads, not UI (rule 11; wording approved by Janik on 2026-11-20)
const aboutLabels: Record<AboutLanguage, AboutLabels> = {
  en: { services: 'Services:', area: 'Service area:', address: 'Address:', commonCalls: 'Common calls:' },
  de: { services: 'Leistungen:', area: 'Einsatzgebiet:', address: 'Adresse:', commonCalls: 'Häufige Anrufe:' },
}
export const aboutLabelsIn = (language: string | null | undefined): AboutLabels =>
  aboutLabels[aboutLanguageOf(language)]
/** The labels in every language that has its own, to read back a text written in any of them. */
export const allAboutLabels: readonly AboutLabels[] = Object.values(aboutLabels)

/**
 * The template for a business that was looked up: the one of its kind (kindFor: its Google category first, then words
 * in its name); null when neither tells (the owner chooses, "Something else" included).
 */
export const templateFor = (business: Parameters<typeof kindFor>[0]): BusinessTemplateId | null =>
  templateOfKind(kindFor(business))

/**
 * The greeting with the business's name, in the shape a new workspace starts with (apps/api/src/onboarding.ts): in the
 * workspace's language (the default greeting of spoken-lines.ts; English for a language calls are not answered in),
 * with the AI note of the default disclosure mode ("This is Maya, the AI assistant."), as the settings write it.
 */
export const greetingFor = (business: string, assistant: string, language: string | null = 'en') => {
  const lang = voiceLanguageOf(language)
  return greetingWithDisclosure(
    spokenLines(lang).greeting(business.trim(), assistant.trim(), false),
    assistant.trim(),
    DEFAULT_AI_DISCLOSURE,
    lang,
  )
}

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
  /** The listing's country (ISO 3166-1 alpha-2); null without a listing. Missing from an older API. */
  country?: string | null
  /** As Google gives it, international ("+1 503-555-0142"). */
  phone: string | null
  website: string | null
  hours: BusinessHoursSpan[] | null
  /** Google's own week, one line per day ("Monday: 7:00 AM – 6:00 PM"). */
  hoursText: string[]
  /** The IANA zone of the listing. */
  timeZone: string | null
  /**
   * The kind of business (business-kind.ts): from the Google category, else the website (the language model), else
   * words in the name; null when none tells (the owner chooses). Missing from an older API.
   */
  kind?: BusinessKind | null
  /** The kind's template (templateOfKind); null without a kind. */
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
    "Propose the business's profile for review: the Google Places listing (`placeId`, from business.search: address, phone, hours, website, category) and/or a `name` and `website`, then the website read like knowledge.import (robots.txt respected). Returns name, address, area, phone, hours, services, a short About text, use cases, a greeting, the kind of business (`kind`, one of the fixed list; save it with workspace.updateSettings `businessKind` once the owner confirms it) and its industry template. Changes nothing: the owner reviews it and saves with assistant.update and businessHours.set.",
  input: z
    .object({
      assistantId: z.string().min(1),
      placeId: placeId.optional(),
      name: z.string().trim().max(BUSINESS_NAME_MAX).optional(),
      website: z.string().trim().max(2000).optional(),
    })
    .refine(i => i.placeId || i.name || i.website, { message: 'give the listing, the business name or its website' }),
  permission: 'settings:write',
  readOnly: true, // As knowledge.import: if the read is ever logged, the website keeps only its host (LIN-507).
  loggedHostOnly: ['website'],
})
