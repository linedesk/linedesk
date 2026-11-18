// The reads and writes of number requests (docs/numbers-kyc.md): none of it is synced (the profile and documents never
// reach a browser's store), so each read is a cached query and each write puts its answer into it at once (CLAUDE.md
// rule 3). Shared by Settings › Phone numbers and the onboarding phone step.
import type {
  KycCountry,
  NumberRequestCountriesData,
  NumberRequirementsData,
  RegulatoryDocumentKind,
  RegulatoryProfileData,
  RegulatoryProfileInput,
} from '@linedesk/actions'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { fileBase64, type RequestRow } from './numberRequestModel.ts'
import { callAction, readAction } from './settings-api.ts'

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

/** The business profile and the documents by name. */
export const useRegulatoryProfile = (enabled: boolean) =>
  useQuery(enabled ? PROFILE : null, () => readAction<RegulatoryProfileData>('numberRequest.getProfile'))

/** What a number in the country needs: fields, documents, cities. */
export const useNumberRequirements = (country: KycCountry | null) =>
  useQuery(country ? requirementsKey(country) : null, () =>
    readAction<NumberRequirementsData>('numberRequest.requirements', { country }),
  )

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

/** Sends the request. `addressOutsideArea`: the server's own check of the address against the number's city. */
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
