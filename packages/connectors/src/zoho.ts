import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js'
import { type CrmContact, type CrmFields, type CrmProvider, pushCallToCrm } from './crm.ts'
import { callNoteText } from './jobber.ts'
import {
  type AppAccount,
  type AppConnector,
  AppError,
  type AppOAuth,
  GrantRevoked,
  type Json,
  type OAuthClient,
  type OAuthTokens,
  type TokenSource,
} from './types.ts'

/**
 * Zoho CRM (docs/crm-sync.md, "Zoho CRM"). OAuth 2 with the install's server-based client from Zoho's API console
 * (Server admin › Providers), Multi-DC on: a Zoho account lives in one data centre (US, EU, India, ...), and its
 * tokens, API and refreshes are only there. The consent page starts at accounts.zoho.com; Zoho sends the browser back
 * with `accounts-server` naming the account's data centre, which is taken only from the list below (never any host
 * the browser names: the client secret goes there). The data centre travels with every token (`<dc>|<token>`, stored
 * encrypted as always), so refreshes and API calls go to the right one. Access tokens last an hour; the refresh token
 * does not run out and is not rotated.
 */
export const ZOHO_SCOPES = [
  'ZohoCRM.modules.contacts.ALL',
  'ZohoCRM.modules.calls.CREATE',
  // The search API needs it beside the module's read scope (Zoho answers OAUTH_SCOPE_MISMATCH without it).
  'ZohoSearch.securesearch.READ',
  'ZohoCRM.org.READ',
] as const

/** The CRM API version every request names (zoho.com/crm/developer/docs/api/v8). */
export const ZOHO_API_VERSION = 'v8'

/**
 * Zoho's data centres: the accounts server (OAuth, as accounts.zoho.com/oauth/serverinfo lists them, 2026-11) and the
 * API domain of each. China is left out: its sign-in does not start at accounts.zoho.com.
 */
export const ZOHO_DATA_CENTERS = {
  us: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  au: { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
  uk: { accounts: 'https://accounts.zoho.uk', api: 'https://www.zohoapis.uk' },
  sg: { accounts: 'https://accounts.zoho.sg', api: 'https://www.zohoapis.sg' },
  ae: { accounts: 'https://accounts.zoho.ae', api: 'https://www.zohoapis.ae' },
} as const
export type ZohoDataCenter = keyof typeof ZOHO_DATA_CENTERS

const isDataCenter = (value: string): value is ZohoDataCenter => Object.hasOwn(ZOHO_DATA_CENTERS, value)

/** The data centre of an accounts server Zoho named in its callback; null for anything not on the list. */
export function zohoDataCenter(accountsServer: string | undefined): ZohoDataCenter | null {
  if (accountsServer === undefined || accountsServer === '') return 'us'
  let origin: string
  try {
    const url = new URL(accountsServer)
    if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== ''))
      return null
    origin = url.origin
  } catch {
    return null
  }
  const found = Object.entries(ZOHO_DATA_CENTERS).find(([, dc]) => dc.accounts === origin)
  return found ? (found[0] as ZohoDataCenter) : null
}

const SEP = '|'
const withDc = (dc: ZohoDataCenter, token: string) => `${dc}${SEP}${token}`

/** A stored token and its data centre. A token without one (never stored so) cannot be used: connect again. */
export function splitDc(stored: string): { dc: ZohoDataCenter; token: string } {
  const at = stored.indexOf(SEP)
  const dc = at > 0 ? stored.slice(0, at) : ''
  if (!isDataCenter(dc)) throw new AppError('zoho', 'auth', 'the stored access names no data centre: connect it again')
  return { dc, token: stored.slice(at + 1) }
}

type Options = {
  fetch?: typeof fetch
  timeoutMs?: number
  dataCenters?: Record<ZohoDataCenter, { accounts: string; api: string }>
}

async function readJson(res: Response): Promise<Json> {
  if (res.status === 204) return {}
  const value = (await res.json().catch(() => ({}))) as unknown
  return value && typeof value === 'object' ? (value as Json) : {}
}

const reasonOf = (body: Json): string | undefined => {
  const value = body.error_description ?? body.message ?? body.error ?? body.code
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined
}

/** Seconds to wait from Retry-After, when Zoho says. */
function retryAfterOf(res: Response): number | undefined {
  const sec = Number(res.headers.get('retry-after'))
  return Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : undefined
}

/** Zoho's answers to the install's own client ID or secret: Server admin's to fix, not one account's grant. */
export const ZOHO_CLIENT_REFUSED = /^(invalid_client|invalid_client_secret|unauthorized_client)$/i
/** Zoho's answer to a refresh token it does not know (any more): revoked, or the client was deleted for the account. */
const GRANT_GONE = /^(invalid_code|invalid_grant|invalid_refresh_token)$/i

export function createZohoOAuth({ clientId, clientSecret }: OAuthClient, options: Options = {}): AppOAuth {
  const { fetch: doFetch = fetch, timeoutMs = 8000, dataCenters = ZOHO_DATA_CENTERS } = options

  /** One call to the accounts server. Zoho answers many refusals with HTTP 200 and an `error` field. */
  async function accounts(dc: ZohoDataCenter, path: string, fields: Record<string, string>, what: string) {
    let res: Response
    try {
      res = await doFetch(`${dataCenters[dc].accounts}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new AppError('zoho', 'unavailable', `${what} could not reach Zoho`)
    }
    const body = await readJson(res)
    const code = typeof body.error === 'string' ? body.error : null
    if (res.ok && !code) return body
    const message = `${what} failed${reasonOf(body) ? `: ${reasonOf(body)}` : ''}`
    if (res.status === 429 || /access denied|too many requests/i.test(String(body.error_description ?? '')))
      throw new AppError('zoho', 'rate_limited', message, res.status === 200 ? 429 : res.status, retryAfterOf(res))
    if (res.status >= 500) throw new AppError('zoho', 'unavailable', message, res.status)
    if (code && ZOHO_CLIENT_REFUSED.test(code)) throw new AppError('zoho', 'client', message, res.status)
    // Only a refresh proves the grant is gone: the token it sent is the grant itself.
    if (fields.grant_type === 'refresh_token' && code && GRANT_GONE.test(code))
      throw new GrantRevoked('zoho', message, res.status)
    throw new AppError('zoho', 'auth', message, res.status)
  }

  async function tokens(dc: ZohoDataCenter, fields: Record<string, string>, what: string): Promise<OAuthTokens> {
    const body = await accounts(
      dc,
      '/oauth/v2/token',
      { ...fields, client_id: clientId, client_secret: clientSecret },
      what,
    )
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw new AppError('zoho', 'invalid', `${what} returned no access token`)
    const expiresIn = Number(body.expires_in)
    return {
      accessToken: withDc(dc, body.access_token),
      refreshToken:
        typeof body.refresh_token === 'string' && body.refresh_token ? withDc(dc, body.refresh_token) : null,
      expiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: typeof body.scope === 'string' ? body.scope : null,
    }
  }

  const crm = crmClient(options)

  return {
    id: 'zoho',
    scopes: ZOHO_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      // Always the US accounts server: with Multi-DC on, Zoho signs the member in wherever their account lives and
      // names that data centre in the callback (`accounts-server`).
      const url = new URL(`${ZOHO_DATA_CENTERS.us.accounts}/oauth/v2/auth`)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: ZOHO_SCOPES.join(','),
        redirect_uri: redirectUri,
        // offline: a refresh token, for calls that end when nobody is signed in. consent: a new refresh token each
        // time, so connecting again never reuses a grant another workspace holds.
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString()
      return url.toString()
    },
    async exchangeCode({ code, redirectUri, params }) {
      const dc = zohoDataCenter(params?.['accounts-server'])
      if (!dc) throw new AppError('zoho', 'invalid', 'the callback names an unknown Zoho data centre')
      return tokens(dc, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'connect')
    },
    async refresh(stored) {
      const { dc, token } = splitDc(stored)
      const refreshed = await tokens(dc, { grant_type: 'refresh_token', refresh_token: token }, 'refresh access')
      // Zoho keeps the refresh token: the stored one stays.
      return { ...refreshed, refreshToken: null }
    },
    // Revoking the refresh token ends the access tokens made from it. Only 200 counts: Zoho answers 400 alike for a
    // token it does not know and for client keys it refuses.
    async revoke(stored) {
      try {
        const { dc, token } = splitDc(stored)
        const res = await doFetch(`${dataCenters[dc].accounts}/oauth/v2/revoke/token`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({ token, token_type: 'refresh_token' }).toString(),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok
      } catch {
        return false
      }
    },
    account: accessToken => crm.org(accessToken),
  }
}

// --- Contacts and calls -----------------------------------------------------------------------

const CONTACT_FIELDS = ['First_Name', 'Last_Name', 'Email', 'Phone', 'Mobile'] as const

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** The digits of a number as written in Zoho ("(503) 555-0142"), compared on the national number. */
function nationalDigits(number: string, country: CountryCode | undefined): string | null {
  const parsed = parsePhoneNumberFromString(number, country ?? 'US')
  if (parsed?.nationalNumber) return String(parsed.nationalNumber)
  const digits = number.replace(/\D/g, '')
  return digits.length >= 7 ? digits : null
}

/**
 * A contact made for a caller with no name has the number as its last name (Zoho needs Last_Name): that counts as
 * empty, so a later call that learns the name fills it.
 */
const placeholderName = (firstName: string | null, lastName: string | null) =>
  !firstName && !!lastName && /^[\d\s()+.-]+$/.test(lastName) && lastName.replace(/\D/g, '').length >= 7

function toContact(row: Json): CrmContact {
  const firstName = text(row.First_Name)
  let lastName = text(row.Last_Name)
  if (placeholderName(firstName, lastName)) lastName = null
  return {
    id: String(row.id),
    firstName,
    lastName,
    email: text(row.Email),
    phone: text(row.Phone) ?? text(row.Mobile),
    // A Zoho contact's company is a lookup to an Account record, not a field Linedesk fills.
    company: null,
  }
}

/** A Zoho contact counts only if one of its numbers is the caller's (Zoho keeps numbers as typed). */
function hasNumber(row: Json, e164: string) {
  const country = parsePhoneNumberFromString(e164)?.country
  const want = nationalDigits(e164, undefined)
  return (
    !!want &&
    [row.Phone, row.Mobile].some(n => typeof n === 'string' && n.trim() && nationalDigits(n, country) === want)
  )
}

/**
 * What to search for: Zoho's search takes no special characters, so digits only: the national number, then with the
 * country code. A hit still counts only when one of its numbers is the caller's (hasNumber).
 */
export function zohoPhoneSearchTerms(e164: string): string[] {
  const parsed = parsePhoneNumberFromString(e164)
  const terms = [parsed?.nationalNumber ? String(parsed.nationalNumber) : null, e164.replace(/\D/g, '')]
  return [...new Set(terms.filter((t): t is string => !!t && t.length >= 2))]
}

function toRecord(fields: Partial<CrmFields>): Json {
  const record: Json = {}
  if (fields.firstName) record.First_Name = fields.firstName
  if (fields.lastName) record.Last_Name = fields.lastName
  if (fields.email) record.Email = fields.email
  if (fields.phone) record.Phone = fields.phone
  return record
}

/** Zoho's call duration: "mm:ss", minutes as many as needed. Never zero: Zoho refuses that for a finished call. */
export function zohoDuration(sec: number): string {
  const total = Math.max(1, Math.round(sec))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Zoho's date-time: ISO 8601 with an offset and no milliseconds ("2026-11-16T15:00:00+00:00"). */
export const zohoDateTime = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, '+00:00')

/** The first row of a write's answer: `{ data: [{ code, details, message, status }] }`. */
const firstRow = (body: Json): Json | undefined => (Array.isArray(body.data) ? (body.data[0] as Json) : undefined)

function kindOf(status: number, code: string | undefined) {
  // 401 (INVALID_TOKEN, OAUTH_SCOPE_MISMATCH), 403 (NO_PERMISSION) and 400 AUTHORIZATION_FAILED (the connecting
  // member's Zoho profile lacks a permission): someone must connect again or fix the profile.
  if (status === 401 || status === 403 || code === 'AUTHORIZATION_FAILED') return 'auth' as const
  if (status === 429 || code === 'TOO_MANY_REQUESTS') return 'rate_limited' as const
  if (status >= 500) return 'unavailable' as const
  if (status === 404) return 'not_found' as const
  return 'invalid' as const
}

type Request = (
  token: TokenSource,
  method: string,
  path: string,
  what: string,
  body?: unknown,
) => Promise<{ status: number; body: Json }>

function crmClient({ fetch: doFetch = fetch, timeoutMs = 10_000, dataCenters = ZOHO_DATA_CENTERS }: Options) {
  /**
   * One API call to the data centre the token names; on 401 it refreshes the token once and tries again. 2xx (204:
   * nothing found) and 400 (Zoho refused the data or the id: INVALID_DATA, DUPLICATE_DATA, ...) are returned for the
   * caller to read; everything else throws.
   */
  const request: Request = async (token, method, path, what, body) => {
    for (let attempt = 0; ; attempt++) {
      const { dc, token: accessToken } = splitDc(await token(attempt > 0))
      let res: Response
      try {
        res = await doFetch(`${dataCenters[dc].api}/crm/${ZOHO_API_VERSION}${path}`, {
          method,
          headers: {
            authorization: `Zoho-oauthtoken ${accessToken}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new AppError('zoho', 'unavailable', `${what} could not reach Zoho`)
      }
      if (res.status === 401 && attempt === 0) continue
      const json = await readJson(res)
      const code = typeof json.code === 'string' ? json.code : undefined
      if (res.ok || (res.status === 400 && code !== 'AUTHORIZATION_FAILED')) return { status: res.status, body: json }
      const kind = kindOf(res.status, code)
      throw new AppError(
        'zoho',
        kind,
        `${what} failed${reasonOf(json) ? `: ${reasonOf(json)}` : ''}`,
        res.status,
        kind === 'rate_limited' ? retryAfterOf(res) : undefined,
      )
    }
  }

  async function org(accessToken: string): Promise<AppAccount> {
    const { body } = await request(async () => accessToken, 'GET', '/org', 'reading the account')
    const row = Array.isArray(body.org) ? (body.org[0] as Json | undefined) : undefined
    if (!row?.id) throw new AppError('zoho', 'invalid', 'reading the account returned no organization')
    const name = text(row.company_name) ?? text(row.domain_name) ?? String(row.id)
    return { id: String(row.id), name }
  }

  return { request, org }
}

/** Fails with the row's own words when a write did not succeed; the id of the record when it did. */
function writtenId(status: number, body: Json, what: string): string {
  const row = firstRow(body) ?? body
  const id = (row.details as Json | undefined)?.id
  if (row.status === 'success' && id !== undefined) return String(id)
  const code = typeof row.code === 'string' ? row.code : undefined
  const message = typeof row.message === 'string' ? row.message.slice(0, 300) : code
  throw new AppError(
    'zoho',
    goneId(row) ? 'not_found' : 'invalid',
    `${what} failed${message ? `: ${message}` : ''}`,
    status,
  )
}

/** Zoho's answer to an id it does not know: INVALID_DATA, "the id given seems to be invalid". */
const goneId = (row: Json) =>
  row.code === 'INVALID_DATA' &&
  (String((row.details as Json | undefined)?.api_name ?? '') === 'id' || /\bid\b/i.test(String(row.message ?? '')))

export function createZohoCrm(options: Options = {}): CrmProvider {
  const { request } = crmClient(options)
  const fields = CONTACT_FIELDS.join(',')

  async function search(token: TokenSource, param: 'phone' | 'email', value: string, what: string) {
    const query = new URLSearchParams({ [param]: value, fields, per_page: '20' })
    const { status, body } = await request(token, 'GET', `/Contacts/search?${query}`, what)
    // 204: nothing found. 400: Zoho cannot search for this value (INVALID_DATA), so nothing found by it either.
    if (status === 204 || status === 400) return []
    return Array.isArray(body.data) ? (body.data as Json[]) : []
  }

  const crm: CrmProvider = {
    app: 'zoho',
    async getContact(token, id) {
      const { status, body } = await request(
        token,
        'GET',
        `/Contacts/${encodeURIComponent(id)}?${new URLSearchParams({ fields })}`,
        'reading the contact',
      )
      // 204 or 400 INVALID_DATA: the contact is gone (deleted or merged away).
      if (status === 400 && !goneId(firstRow(body) ?? body)) writtenId(status, body, 'reading the contact')
      const row = Array.isArray(body.data) ? (body.data[0] as Json | undefined) : undefined
      return status !== 200 || !row?.id ? null : toContact(row)
    },
    async findContactByPhone(token, e164) {
      for (const term of zohoPhoneSearchTerms(e164)) {
        const rows = await search(token, 'phone', term, 'finding the contact by phone')
        const found = rows.find(row => hasNumber(row, e164))
        if (found) return toContact(found)
      }
      return null
    },
    async findContactByEmail(token, email) {
      const rows = await search(token, 'email', email, 'finding the contact by email')
      const found = rows.find(row => String(row.Email ?? '').toLowerCase() === email.toLowerCase())
      return found ? toContact(found) : null
    },
    async createContact(token, known) {
      const record = toRecord(known)
      // Zoho needs a last name: a caller with no name is named by their number until a call says more.
      if (!record.Last_Name) {
        if (record.First_Name) {
          record.Last_Name = record.First_Name
          delete record.First_Name
        } else if (known.phone) {
          record.Last_Name = parsePhoneNumberFromString(known.phone)?.formatNational() ?? known.phone
        } else {
          record.Last_Name = known.email ?? '-'
        }
      }
      const { status, body } = await request(token, 'POST', '/Contacts', 'creating the contact', { data: [record] })
      const row = firstRow(body) ?? body
      if (row.code === 'DUPLICATE_DATA') {
        // A field the org made unique (often the email) belongs to a contact the phone search did not find: that one.
        const details = (row.details ?? {}) as Json
        const duplicateId =
          (details.duplicate_record as Json | undefined)?.id ?? (details.module as Json | undefined)?.id
        const found =
          duplicateId !== undefined
            ? await crm.getContact(token, String(duplicateId))
            : known.email
              ? await crm.findContactByEmail(token, known.email)
              : null
        if (found) return found
      }
      const id = writtenId(status, body, 'creating the contact')
      return toContact({ ...record, id })
    },
    async fillContact(token, id, patch) {
      const path = `/Contacts/${encodeURIComponent(id)}`
      let { status, body } = await request(token, 'PUT', path, 'updating the contact', { data: [toRecord(patch)] })
      if ((firstRow(body) ?? body).code === 'DUPLICATE_DATA' && patch.email) {
        // Another contact already has this email; fill the rest without it.
        const { email: _email, ...rest } = patch
        if (Object.keys(toRecord(rest)).length === 0) return
        ;({ status, body } = await request(token, 'PUT', path, 'updating the contact', { data: [toRecord(rest)] }))
      }
      writtenId(status, body, 'updating the contact')
    },
    async logCall(token, contactId, call) {
      const inbound = call.direction === 'in'
      const record: Json = {
        Subject: (call.urgent ? `${call.title.trim()} (${call.labels.urgent})` : call.title.trim()).slice(0, 255),
        Call_Type: inbound ? 'Inbound' : 'Outbound',
        Call_Start_Time: zohoDateTime(call.startedAt),
        Call_Duration: zohoDuration(call.durationSec),
        Description: callNoteText(call),
        Who_Id: { id: contactId },
      }
      if (!inbound) record.Outbound_Call_Status = 'Completed'
      const { status, body } = await request(token, 'POST', '/Calls', 'logging the call', { data: [record] })
      return writtenId(status, body, 'logging the call')
    },
  }
  return crm
}

export function createZohoConnector(options: Options = {}): AppConnector {
  const crm = createZohoCrm(options)
  return {
    id: 'zoho',
    crm: true,
    pushCall: (token, call, progress, pushOptions) => pushCallToCrm(crm, token, call, progress, pushOptions),
  }
}
