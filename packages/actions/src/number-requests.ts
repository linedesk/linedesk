// Number requests in countries whose carrier asks for documents first (KYC; docs/numbers-kyc.md). Owners and admins
// only (settings:write), never an API key (not public). Which countries are open is the server's flag
// (NUMBER_KYC_COUNTRIES): with none open, every action but `numberRequest.countries` refuses. Handlers in
// apps/api/src/number-requests.ts.
import { z } from 'zod'
import { defineAction } from './define.ts'
import {
  KYC_COUNTRIES,
  type KycCountry,
  type NumberCity,
  REGULATORY_DOCUMENT_MAX_BYTES,
  type RegulatoryDocumentKind,
  type RegulatoryField,
  regulatoryDocumentKinds,
  regulatoryDocumentTypes,
  regulatoryEntityTypes,
} from './number-countries.ts'

export const numberRequestStatuses = [
  'requested',
  'submitted',
  'pending_review',
  'approved',
  'active',
  'rejected',
  'cancelled',
  'needs_operator',
] as const
export type NumberRequestStatus = (typeof numberRequestStatuses)[number]
/**
 * Statuses in which the carrier still decides: refreshed from the carrier, count against the open requests a workspace
 * may have. `needs_operator` is not open: the carrier approved, but the number could not be set up (in use elsewhere,
 * routing failed, not on the account); the operator sets it up or releases it (ALERT in the log), the workspace is not
 * held up by it.
 */
export const OPEN_NUMBER_REQUEST_STATUSES: readonly NumberRequestStatus[] = [
  'requested',
  'submitted',
  'pending_review',
  'approved',
]

const country = z.enum(KYC_COUNTRIES)
const line = (max: number) => z.string().trim().min(1).max(max)

export const regulatoryProfileInput = z
  .object({
    legal_name: line(200),
    entity_type: z.enum(regulatoryEntityTypes),
    registration_number: line(100).optional(),
    register_court: line(200).optional(),
    website: z.string().trim().url().max(300).optional(),
    use_case: line(1000).optional(),
    address: z
      .object({
        street: line(200),
        extended: z.string().trim().max(200).optional(),
        city: line(100),
        postal_code: line(20),
        region: z.string().trim().max(100).optional(),
        country: z.string().regex(/^[A-Z]{2}$/),
      })
      .strict(),
    contact: z
      .object({
        first_name: line(100),
        last_name: line(100),
        email: z.string().trim().email().max(200),
        phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
      })
      .strict(),
  })
  .strict()
export type RegulatoryProfileInput = z.infer<typeof regulatoryProfileInput>

/** A document as the app lists it: never its content. */
export type RegulatoryDocumentSummary = {
  id: string
  kind: RegulatoryDocumentKind
  filename: string
  contentType: string
  size: number
  createdAt: string
}

/** A number request as the app shows it. `reason`: why it was rejected or could not be set up. */
export type NumberRequestSummary = {
  id: string
  country: KycCountry
  prefix: string
  /**
   * The popular city's id (NumberCity.id) when the area is one of them, so the app can show its translated name;
   * otherwise empty, and the app shows `areaName`.
   */
  city: string
  /** The area's own name (Germany: the Ortsnetz's name as the BNetzA writes it, "Heidelberg"); null if not known. */
  areaName: string | null
  status: NumberRequestStatus
  reason: string | null
  e164: string | null
  phoneNumberId: string | null
  createdAt: string
  updatedAt: string
}

/** `data` of numberRequest.requirements: what the business has to give for a number in the country. */
export type NumberRequirementsData = {
  country: KycCountry
  numberType: 'local'
  fields: readonly RegulatoryField[]
  documents: readonly RegulatoryDocumentKind[]
  addressInArea: boolean
  /** The popular cities (suggestions; with `anyArea` every area code of the country can be asked for). */
  cities: readonly NumberCity[]
  /** Any area code of the country can be asked for (Germany): search them with numberRequest.areas. */
  anyArea: boolean
  /**
   * The monthly number fee is waived for numbers in this country (the instance's billing rule
   * `regulatedNumberFeeWaived`, on by default: free during the beta). False on a workspace's own carrier account,
   * where Linedesk never charged for the number.
   */
  monthlyFeeWaived: boolean
  /**
   * Numbers are offered only in the areas where the install's carrier holds number blocks of its own (the instance
   * setting numberBlocks, Germany on the install's carrier account): `available` on each area says which.
   */
  carrierBlocksOnly: boolean
  /** What is still missing in the workspace's profile and documents for this country. */
  missing: { fields: RegulatoryField[]; documents: RegulatoryDocumentKind[] }
}

/**
 * An area a number can be asked for. `prefix`: the area code without the trunk 0 (Heidelberg 06221: `6221`); `name`:
 * the area's name (Germany: the Ortsnetz as the BNetzA writes it, "Neustadt a d Aisch"); `place`: the place the search
 * or the address matched when it is not the area's own name (Dossenheim is in the area Heidelberg 6221); `city`: the
 * popular city's id when the area is one (NumberCity.id, for its translated name); `popular`: one of the suggestions
 * shown before anything is searched; `available`: a number can be requested there (false only under the carrier
 * blocks rule, in an area where the carrier holds no number block: "no local number available for your area yet").
 */
export type NumberArea = {
  prefix: string
  name: string
  place?: string
  city?: string
  popular: boolean
  available: boolean
}

/**
 * `data` of numberRequest.areas. `areas`: what the query found (the popular areas when it is empty). `suggested`:
 * the areas of the address (the one given, else the saved profile's when it is in the country), best first; empty
 * when the address names no known place. A suggestion only: any available area can be asked for. `carrierBlocksOnly`:
 * as in NumberRequirementsData; then the empty query lists the available areas, and an area without blocks is still
 * found (by its name, a place or the address) with `available: false`.
 */
export type NumberAreasData = {
  country: KycCountry
  areas: NumberArea[]
  suggested: NumberArea[]
  carrierBlocksOnly: boolean
}

/**
 * `data` of numberBlocks.get and numberBlocks.set: whether German numbers on the install's carrier account are offered
 * only where the carrier holds number blocks of its own (BNetzA Mitteilung 90/2026). `byDefault`: no admin chose; it
 * is on when the install's carrier is Telnyx. `portingId`: the carrier's BNetzA porting ID (D451, Telnyx Ireland Ltd);
 * `areas`: how many Ortsnetze it holds blocks in.
 */
export type NumberBlocksData = { on: boolean; byDefault: boolean; portingId: string; areas: number }

/** `data` of numberRequest.countries: the countries open on this server (empty: the flag is off). */
export type NumberRequestCountriesData = { countries: KycCountry[] }

/** `data` of numberRequest.getProfile. */
export type RegulatoryProfileData = {
  profile: RegulatoryProfileInput | null
  documents: RegulatoryDocumentSummary[]
}

export const numberRequestCountries = defineAction({
  name: 'numberRequest.countries',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'List the countries this server takes number requests for (numbers that need documents first, such as Germany, the UK and Ireland). Empty while the server has none switched on.',
  input: z.object({}).strict(),
  permission: 'settings:write',
  readOnly: true,
})

export const numberRequestRequirements = defineAction({
  name: 'numberRequest.requirements',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "What a number in `country` needs before the carrier activates it: the fields of the workspace's regulatory profile, the documents, the cities to pick from, and what is still missing.",
  input: z.object({ country, numberType: z.enum(['local']).default('local') }).strict(),
  permission: 'settings:write',
  readOnly: true,
})

export const numberRequestAreas = defineAction({
  name: 'numberRequest.areas',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Search the areas a number can be requested in: `query` is a place or an area code ("Heidelberg", "Dossenheim", "06221"); empty, the popular cities. Germany has every Ortsnetz; the UK and Ireland their listed cities. Under the carrier blocks rule (`carrierBlocksOnly`) an area without blocks has `available: false`: no local number there yet. `suggested` lists the areas of `address` (city and postal code), else of the saved profile\'s address: a suggestion, any area can be requested.',
  input: z
    .object({
      country,
      query: z.string().trim().max(100).default(''),
      address: z
        .object({ city: z.string().trim().max(100).optional(), postal_code: z.string().trim().max(20).optional() })
        .strict()
        .optional(),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  permission: 'settings:write',
  readOnly: true,
})

export const numberBlocksGet = defineAction({
  name: 'numberBlocks.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Whether German numbers on this install's carrier account are offered only in the Ortsnetze where the carrier holds number blocks of its own (BNetzA Mitteilung 90/2026). On by default when the carrier is Telnyx.",
  input: z.object({}).strict(),
  permission: 'instance:admin',
  readOnly: true,
})

export const numberBlocksSet = defineAction({
  name: 'numberBlocks.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Offer German numbers on this install's carrier account only where the carrier holds number blocks of its own (on), or in every Ortsnetz (off: an install with its own licence or carrier contract). Workspaces on their own carrier account are never restricted. Requests already made are kept.",
  input: z.object({ on: z.boolean() }).strict(),
  permission: 'instance:admin',
})

export const numberRequestGetProfile = defineAction({
  name: 'numberRequest.getProfile',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The workspace's regulatory profile (legal name, type, registration number, address, contact) and its uploaded documents by name; document contents are never returned.",
  input: z.object({}).strict(),
  permission: 'settings:write',
  readOnly: true,
})

export const numberRequestSaveProfile = defineAction({
  name: 'numberRequest.saveProfile',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Save the workspace's regulatory profile: who holds its numbers in countries that need documents (legal name, type, registration number, website, use case, address, contact). Replaces the saved one.",
  input: regulatoryProfileInput,
  permission: 'settings:write',
  // Names, address, phone and email of the business: the command log keeps ids only.
  logged: 'ids',
})

/** The base64 length of the largest document. */
const MAX_BASE64 = Math.ceil(REGULATORY_DOCUMENT_MAX_BYTES / 3) * 4

export const numberRequestUploadDocument = defineAction({
  name: 'numberRequest.uploadDocument',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Upload a document for number requests (ID or registration certificate, proof of address, BNetzA form): a PDF, PNG or JPEG of at most 2.5 MB, base64 in `content`. Stored encrypted; it is only ever sent to the carrier.',
  input: z
    .object({
      kind: z.enum(regulatoryDocumentKinds),
      filename: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^/\\\0]+$/),
      contentType: z.enum(regulatoryDocumentTypes),
      content: z
        .string()
        .min(1)
        .max(MAX_BASE64)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  permission: 'settings:write',
  // The document itself never goes into the command log, nor its filename (often a person's name).
  sensitive: ['content'],
  logged: 'ids',
})

export const numberRequestDeleteDocument = defineAction({
  name: 'numberRequest.deleteDocument',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Delete an uploaded document for good. A request already handed to the carrier keeps the copy the carrier has.',
  input: z.object({ documentId: z.string().min(1) }).strict(),
  permission: 'settings:write',
})

export const numberRequestCreate = defineAction({
  name: 'numberRequest.create',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Request a number in a country that needs documents: `prefix` is the area code (Berlin 30, Heidelberg 6221, London 20, Dublin 1; Germany takes any Ortsnetz, see numberRequest.areas). Refused with `number_request_no_local_numbers` in an area the carrier holds no number block in (the carrier blocks rule, see numberRequest.areas), and with `number_request_no_numbers` when the carrier has no free number in that area right now. Hands the profile and documents to the carrier and orders a number, which costs money once the carrier approves; until then the request is pending (days). Check it with numberRequest.list.',
  input: z
    .object({
      country,
      prefix: z.string().regex(/^0?\d{1,5}$/),
      assistantId: z.string().min(1).optional(),
    })
    .strict(),
  permission: 'settings:write',
})

export const numberRequestList = defineAction({
  name: 'numberRequest.list',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: "The workspace's number requests, newest first, with where each stands and why one was rejected.",
  input: z.object({}).strict(),
  permission: 'settings:write',
  readOnly: true,
})

export const numberRequestRefresh = defineAction({
  name: 'numberRequest.refresh',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Ask the carrier where an open number request stands now, and set the number up when it was approved. Free; the carrier also tells the server by webhook.',
  input: z.object({ requestId: z.string().min(1) }).strict(),
  permission: 'settings:write',
})

export const numberRequestCancel = defineAction({
  name: 'numberRequest.cancel',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Cancel an open number request: the order at the carrier is cancelled, nothing is bought. If the carrier completed the order meanwhile, the number is set up instead and the answer says `cancelled: false`.',
  input: z.object({ requestId: z.string().min(1) }).strict(),
  permission: 'settings:write',
})
