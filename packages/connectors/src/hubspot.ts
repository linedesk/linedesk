import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { type CrmContact, type CrmFields, type CrmProvider, callNoteHtml, pushCallToCrm } from './crm.ts'
import {
  type AppConnector,
  AppError,
  type AppErrorKind,
  type AppOAuth,
  type Json,
  type OAuthClient,
  type OAuthTokens,
  type TokenSource,
} from './types.ts'

/**
 * HubSpot (docs/crm-sync.md). OAuth with the install's public app (Server admin › Providers);
 * access tokens last 30 minutes, so every request goes through a TokenSource that refreshes.
 * Contact scopes are enough: creating a call associated with a contact accepts crm.objects.contacts.write.
 */
export const HUBSPOT_SCOPES = ['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write'] as const

const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize'
export const HUBSPOT_API = 'https://api.hubapi.com'
/** HubSpot-defined association type: call → contact. */
const CALL_TO_CONTACT = 194

type Options = { fetch?: typeof fetch; timeoutMs?: number; api?: string }

function kindOf(status: number): AppErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

const reasonOf = (body: Json): string | undefined => {
  const text = body.message ?? body.error_description ?? body.error
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, 300) : undefined
}

async function readJson(res: Response): Promise<Json> {
  if (res.status === 204) return {}
  return ((await res.json().catch(() => ({}))) ?? {}) as Json
}

export function createHubSpotOAuth(
  { clientId, clientSecret }: OAuthClient,
  { fetch: doFetch = fetch, timeoutMs = 8000, api = HUBSPOT_API }: Options = {},
): AppOAuth {
  async function form(path: string, fields: Record<string, string>, what: string): Promise<Json> {
    let res: Response
    try {
      res = await doFetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new AppError('hubspot', 'unavailable', `${what} could not reach HubSpot`)
    }
    const body = await readJson(res)
    if (!res.ok) {
      // invalid_grant / BAD_REFRESH_TOKEN: the app was uninstalled or the grant expired.
      const kind = res.status >= 500 ? 'unavailable' : res.status === 429 ? 'rate_limited' : 'auth'
      throw new AppError('hubspot', kind, `${what} failed${reasonOf(body) ? `: ${reasonOf(body)}` : ''}`, res.status)
    }
    return body
  }
  async function tokens(fields: Record<string, string>, what: string): Promise<OAuthTokens> {
    const body = await form('/oauth/v3/token', { ...fields, client_id: clientId, client_secret: clientSecret }, what)
    if (typeof body.access_token !== 'string')
      throw new AppError('hubspot', 'invalid', `${what} returned no access token`)
    const expiresIn = Number(body.expires_in)
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: Array.isArray(body.scopes) ? body.scopes.join(' ') : typeof body.scope === 'string' ? body.scope : null,
    }
  }
  return {
    id: 'hubspot',
    scopes: HUBSPOT_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: HUBSPOT_SCOPES.join(' '),
        state,
      }).toString()
      return url.toString()
    },
    exchangeCode: ({ code, redirectUri }) =>
      tokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'connect'),
    refresh: refreshToken => tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'refresh access'),
    // v1 until HubSpot's date-versioned revoke (/oauth/2026-03/token/revoke) has documented fields; v1 works until 2027-02.
    async revoke(refreshToken) {
      try {
        const res = await doFetch(`${api}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok
      } catch {
        return false
      }
    },
    async account(accessToken) {
      const body = await form(
        '/oauth/v3/token/introspect',
        // HubSpot's v3 guide names the field after the hint, its 2026-03 guide `token`: both are sent.
        {
          client_id: clientId,
          client_secret: clientSecret,
          token_type_hint: 'access_token',
          access_token: accessToken,
          token: accessToken,
        },
        'reading the account',
      )
      const hubId = body.hub_id
      if (hubId === undefined || hubId === null)
        throw new AppError('hubspot', 'invalid', 'reading the account returned no portal')
      const domain = typeof body.hub_domain === 'string' && body.hub_domain.trim() ? body.hub_domain.trim() : null
      return { id: String(hubId), name: domain ?? String(hubId) }
    },
  }
}

const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company'] as const

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

function toContact(row: Json): CrmContact {
  const p = (row.properties ?? {}) as Json
  return {
    id: String(row.id),
    firstName: text(p.firstname),
    lastName: text(p.lastname),
    email: text(p.email),
    phone: text(p.phone) ?? text(p.mobilephone),
    company: text(p.company),
  }
}

function toProperties(fields: Partial<CrmFields>): Record<string, string> {
  const props: Record<string, string> = {}
  if (fields.firstName) props.firstname = fields.firstName
  if (fields.lastName) props.lastname = fields.lastName
  if (fields.email) props.email = fields.email
  if (fields.phone) props.phone = fields.phone
  if (fields.company) props.company = fields.company
  return props
}

/**
 * HubSpot's searchable phone properties hold the number without country code ("5035550142"),
 * whatever format a person typed; `phone`/`mobilephone` hold it as typed, so E.164 matches too.
 */
export function phoneFilterGroups(e164: string) {
  const national = parsePhoneNumberFromString(e164)?.nationalNumber
  const groups = [
    { filters: [{ propertyName: 'phone', operator: 'EQ', value: e164 }] },
    { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: e164 }] },
  ]
  if (national) {
    groups.push(
      { filters: [{ propertyName: 'hs_searchable_calculated_phone_number', operator: 'EQ', value: national }] },
      { filters: [{ propertyName: 'hs_searchable_calculated_mobile_number', operator: 'EQ', value: national }] },
    )
  }
  return groups
}

export function createHubSpotCrm({
  fetch: doFetch = fetch,
  timeoutMs = 10_000,
  api = HUBSPOT_API,
}: Options = {}): CrmProvider {
  /** One API call; on 401 it refreshes the token once and tries again. */
  async function request(
    token: TokenSource,
    method: string,
    path: string,
    what: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> {
    for (let attempt = 0; ; attempt++) {
      const accessToken = await token(attempt > 0)
      let res: Response
      try {
        res = await doFetch(`${api}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new AppError('hubspot', 'unavailable', `${what} could not reach HubSpot`)
      }
      if (res.status === 401 && attempt === 0) continue
      const json = await readJson(res)
      if (res.ok || res.status === 404 || res.status === 409) return { status: res.status, body: json }
      throw new AppError(
        'hubspot',
        kindOf(res.status),
        `${what} failed${reasonOf(json) ? `: ${reasonOf(json)}` : ''}`,
        res.status,
      )
    }
  }

  async function search(token: TokenSource, filterGroups: unknown[], what: string): Promise<CrmContact | null> {
    const { status, body } = await request(token, 'POST', '/crm/v3/objects/contacts/search', what, {
      filterGroups,
      properties: CONTACT_PROPS,
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: 1,
    })
    if (status !== 200 && status !== 201) throw new AppError('hubspot', 'invalid', `${what} failed (${status})`, status)
    const first = Array.isArray(body.results) ? body.results[0] : undefined
    return first ? toContact(first) : null
  }

  const crm: CrmProvider = {
    app: 'hubspot',
    async getContact(token, id) {
      const query = new URLSearchParams({ properties: CONTACT_PROPS.join(','), archived: 'false' })
      const { status, body } = await request(
        token,
        'GET',
        `/crm/v3/objects/contacts/${encodeURIComponent(id)}?${query}`,
        'reading the contact',
      )
      return status === 404 ? null : toContact(body)
    },
    findContactByPhone: (token, e164) => search(token, phoneFilterGroups(e164), 'finding the contact by phone'),
    findContactByEmail: (token, email) =>
      search(
        token,
        [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }] }],
        'finding the contact by email',
      ),
    async createContact(token, fields) {
      const { status, body } = await request(token, 'POST', '/crm/v3/objects/contacts', 'creating the contact', {
        properties: toProperties(fields),
      })
      if (status === 409) {
        // The email belongs to a contact the phone search did not find.
        const existing = /Existing ID:\s*(\d+)/.exec(String(body.message ?? ''))?.[1]
        const found = existing
          ? await crm.getContact(token, existing)
          : fields.email
            ? await crm.findContactByEmail(token, fields.email)
            : null
        if (found) return found
      }
      if (status !== 200 && status !== 201)
        throw new AppError(
          'hubspot',
          'invalid',
          `creating the contact failed${reasonOf(body) ? `: ${reasonOf(body)}` : ''}`,
          status,
        )
      return toContact(body)
    },
    async fillContact(token, id, fields) {
      const path = `/crm/v3/objects/contacts/${encodeURIComponent(id)}`
      let { status, body } = await request(token, 'PATCH', path, 'updating the contact', {
        properties: toProperties(fields),
      })
      if (status === 409 && fields.email) {
        // Another contact already has this email; fill the rest without it.
        const { email: _email, ...rest } = fields
        if (Object.keys(rest).length === 0) return
        ;({ status, body } = await request(token, 'PATCH', path, 'updating the contact', {
          properties: toProperties(rest),
        }))
      }
      if (status === 404)
        throw new AppError('hubspot', 'not_found', 'updating the contact failed: it no longer exists', 404)
      if (status !== 200)
        throw new AppError(
          'hubspot',
          'invalid',
          `updating the contact failed${reasonOf(body) ? `: ${reasonOf(body)}` : ''}`,
          status,
        )
    },
    async logCall(token, contactId, call) {
      const inbound = call.direction === 'in'
      const properties: Record<string, string> = {
        hs_timestamp: call.startedAt,
        hs_call_title: call.title,
        hs_call_body: callNoteHtml(call),
        hs_call_duration: String(Math.max(0, Math.round(call.durationSec * 1000))),
        hs_call_direction: inbound ? 'INBOUND' : 'OUTBOUND',
        hs_call_status: 'COMPLETED',
      }
      const from = inbound ? call.callerNumber : call.businessNumber
      const to = inbound ? call.businessNumber : call.callerNumber
      if (from) properties.hs_call_from_number = from
      if (to) properties.hs_call_to_number = to
      const { status, body } = await request(token, 'POST', '/crm/v3/objects/calls', 'logging the call', {
        properties,
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: CALL_TO_CONTACT }],
          },
        ],
      })
      if ((status !== 200 && status !== 201) || body.id === undefined) {
        throw new AppError(
          'hubspot',
          status === 404 ? 'not_found' : 'invalid',
          `logging the call failed${reasonOf(body) ? `: ${reasonOf(body)}` : ''}`,
          status,
        )
      }
      return String(body.id)
    },
  }
  return crm
}

export function createHubSpotConnector(options: Options = {}): AppConnector {
  const crm = createHubSpotCrm(options)
  return {
    id: 'hubspot',
    crm: true,
    pushCall: (token, call, progress, pushOptions) => pushCallToCrm(crm, token, call, progress, pushOptions),
  }
}
