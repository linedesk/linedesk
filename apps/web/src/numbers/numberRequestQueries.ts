// The reads and writes of number requests (docs/numbers-kyc.md): none of it is synced (the profile and documents never
// reach a browser's store), so each read is a cached query and each write puts its answer into it at once (CLAUDE.md
// rule 3). Shared by Settings › Phone numbers and the onboarding phone step.
import {
  isKycCountry,
  type KycCountry,
  type NumberAreasData,
  type NumberRequestCountriesData,
  type NumberRequirementsData,
  type RegulatoryDocumentKind,
  type RegulatoryProfileData,
  type RegulatoryProfileInput,
} from '@linedesk/actions'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { callAction, readAction } from '../settings/settings-api.ts'
import { useWorkspaceCountry } from '../workspaceLocale.ts'
import { fileBase64, type RequestRow, requestView } from './numberRequestModel.ts'

const COUNTRIES = 'numberRequest.countries'
const LIST = 'numberRequest.list'
const PROFILE = 'numberRequest.profile'
const requirementsKey = (country: KycCountry) => `numberRequest.requirements:${country}`

/** The countries this server takes requests for; empty while none is switched on. Null key: not asked (members). */
export const useNumberRequestCountries = (enabled: boolean) =>
  useQuery(enabled ? COUNTRIES : null, () => readAction<NumberRequestCountriesData>('numberRequest.countries'), {
    freshMs: 5 * 60_000,
  })

/** The workspace's requests, newest first. */
export const useNumberRequests = (enabled: boolean) =>
  useQuery(
    enabled ? LIST : null,
    async () => (await readAction<{ requests: RequestRow[] }>('numberRequest.list')).requests,
  )

/**
 * The workspace's country when a number there is requested with documents and the server takes requests for it
 * (the onboarding phone step); null otherwise (a US workspace, the flag off, or a member who may not ask).
 * `loading` until that is known.
 */
export function useKycCountry(): { country: KycCountry | null; loading: boolean } {
  const place = useWorkspaceCountry()
  const candidate = place && isKycCountry(place.country) ? place.country : null
  const open = useNumberRequestCountries(!!candidate)
  if (!candidate) return { country: null, loading: false }
  if (!open.data) return { country: null, loading: !open.error }
  return { country: open.data.countries.includes(candidate) ? candidate : null, loading: false }
}

/** Where the workspace's newest request of the country stands (requestView); null while loading or without a country. */
export function useRequestView(country: KycCountry | null) {
  const query = useNumberRequests(!!country)
  return { ...query, view: country && query.data ? requestView(country, query.data) : null }
}

/** The business profile and the documents by name. */
export const useRegulatoryProfile = (enabled: boolean) =>
  useQuery(enabled ? PROFILE : null, () => readAction<RegulatoryProfileData>('numberRequest.getProfile'))

/** What a number in the country needs: fields, documents, cities. */
export const useNumberRequirements = (country: KycCountry | null) =>
  useQuery(country ? requirementsKey(country) : null, () =>
    readAction<NumberRequirementsData>('numberRequest.requirements', { country }),
  )

/**
 * The areas a number can be asked for (numberRequest.areas): what `query` finds (the available ones, popular first,
 * when it is empty) and the areas of the business address, best first. Each search is kept for a while, so typing
 * back finds it at once.
 */
export const useNumberAreas = (
  country: KycCountry | null,
  query: string,
  address: { city: string; postal_code: string } | null,
) => {
  const city = address?.city.trim() ?? ''
  const postal_code = address?.postal_code.trim() ?? ''
  return useQuery(
    country
      ? `numberRequest.areas:${country}:${query.trim().toLowerCase()}:${postal_code}:${city.toLowerCase()}`
      : null,
    () =>
      readAction<NumberAreasData>('numberRequest.areas', {
        country,
        query: query.trim(),
        ...(city || postal_code
          ? { address: { ...(city ? { city } : {}), ...(postal_code ? { postal_code } : {}) } }
          : {}),
        limit: 20,
      }),
    { freshMs: 10 * 60_000 },
  )
}

/** A request as the server answered it, in place in the list (a new one first). */
export function putRequest(request: RequestRow) {
  setQueryData<RequestRow[] | undefined>(LIST, list =>
    list?.some(r => r.id === request.id)
      ? list.map(r => (r.id === request.id ? request : r))
      : [request, ...(list ?? [])],
  )
}

const putProfile = (change: Partial<RegulatoryProfileData>) =>
  setQueryData<RegulatoryProfileData | undefined>(PROFILE, data =>
    data ? { ...data, ...change } : { profile: null, documents: [], ...change },
  )

export async function saveProfile(input: RegulatoryProfileInput) {
  const { profile } = await callAction<{ profile: RegulatoryProfileInput | null }>('numberRequest.saveProfile', input)
  putProfile({ profile })
}

/** Uploads a document and shows it in the list at once (the server's id, the file's own name and size). */
export async function uploadDocument(
  kind: RegulatoryDocumentKind,
  file: File,
  documents: RegulatoryProfileData['documents'],
) {
  const content = await fileBase64(file)
  const { documentId } = await callAction<{ documentId: string }>('numberRequest.uploadDocument', {
    kind,
    filename: file.name,
    contentType: file.type,
    content,
  })
  // The same file uploaded again answers the document it already has.
  if (documents.some(d => d.id === documentId)) return
  putProfile({
    documents: [
      {
        id: documentId,
        kind,
        filename: file.name,
        contentType: file.type,
        size: file.size,
        createdAt: new Date().toISOString(),
      },
      ...documents,
    ],
  })
}

export async function deleteDocument(documentId: string, documents: RegulatoryProfileData['documents']) {
  await callAction('numberRequest.deleteDocument', { documentId })
  putProfile({ documents: documents.filter(d => d.id !== documentId) })
}

/** Sends the request. `addressOutsideArea`: the server's own check of the address against the number's area. */
export async function createRequest(country: KycCountry, prefix: string) {
  const data = await callAction<{ request: RequestRow; addressOutsideArea: boolean }>('numberRequest.create', {
    country,
    prefix,
  })
  putRequest(data.request)
  return data
}

export async function refreshRequest(requestId: string) {
  const { request } = await callAction<{ request: RequestRow }>('numberRequest.refresh', { requestId })
  putRequest(request)
  return request
}

export async function cancelRequest(requestId: string) {
  const { request } = await callAction<{ request: RequestRow }>('numberRequest.cancel', { requestId })
  putRequest(request)
  return request
}
