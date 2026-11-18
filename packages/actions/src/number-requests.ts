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
  regulatoryDocumentKinds,
  regulatoryDocumentTypes,
  regulatoryEntityTypes,
  type RegulatoryField,
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
  /** The city's id (NumberCity.id); the app shows its name. */
  city: string
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
  cities: readonly NumberCity[]
  /** What is still missing in the workspace's profile and documents for this country. */
  missing: { fields: RegulatoryField[]; documents: RegulatoryDocumentKind[] }
}

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
    "Request a number in a country that needs documents: `prefix` is the city's area code (Berlin 30, London 20, Dublin 1). Hands the profile and documents to the carrier and orders a number, which costs money once the carrier approves; until then the request is pending (days). Check it with numberRequest.list.",
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
