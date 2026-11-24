import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js'
import { type CrmContact, type CrmFields, type CrmProvider, pushCallToCrm } from './crm.ts'
import {
  type AppAccount,
  type AppConnector,
  AppError,
  type AppOAuth,
  type FinishedCall,
  type Json,
  type OAuthClient,
  type OAuthTokens,
  type TokenSource,
} from './types.ts'

/**
 * Jobber (docs/crm-sync.md, "Jobber"). OAuth 2 authorization code with the install's Jobber app (Server admin ›
 * Providers); the scopes are set on the app in Jobber's Developer Center, not in the consent URL. Access tokens last
 * 60 minutes; refresh-token rotation is on (Jobber requires it for published apps), so every refresh returns a new
 * refresh token, which the token source stores. Everything else is one GraphQL endpoint with a dated version header.
 */
export const JOBBER_API = 'https://api.getjobber.com'
const AUTHORIZE_PATH = '/api/oauth/authorize'
const TOKEN_PATH = '/api/oauth/token'
const GRAPHQL_PATH = '/api/graphql'
/** The GraphQL version every request names (developer.getjobber.com/docs/changelog). Supported 12 months or more. */
export const JOBBER_GRAPHQL_VERSION = '2026-09-25'
/**
 * The scopes the Jobber app needs (ticked in the Developer Center): clients to find, add and fill the caller, and to
 * add the call as a note on the client. Shown in the key guide and checked when Jobber reports the granted scopes.
 */
export const JOBBER_SCOPES = ['read_clients', 'write_clients'] as const

/** Jobber's answer when the client ID and secret are not an app it knows (HTTP 401, plain text). */
export const JOBBER_CLIENT_REFUSED = /do not match an existing application/i

type Options = { fetch?: typeof fetch; timeoutMs?: number; api?: string }

/** A body that may be JSON or Jobber's plain text. */
async function readBody(res: Response): Promise<{ json: Json; text: string }> {
  const text = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as unknown
    return { json: parsed && typeof parsed === 'object' ? (parsed as Json) : {}, text }
  } catch {
    return { json: {}, text }
  }
}

const reasonOf = ({ json, text }: { json: Json; text: string }): string | undefined => {
  const value = json.error_description ?? json.message ?? json.error ?? text
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, 300) : undefined
}

/** The seconds until a JWT's `exp`, or null. Jobber's access token is a JWT. */
function jwtSecondsLeft(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const exp = Number(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).exp)
    return Number.isFinite(exp) ? exp - Math.floor(Date.now() / 1000) : null
  } catch {
    return null
  }
}

/** Seconds to wait from Retry-After (seconds or an HTTP date); undefined when it says nothing usable. */
function retryAfterOf(res: Response): number | undefined {
  const value = res.headers.get('retry-after')
  if (!value) return undefined
  const sec = Number(value)
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 1000)) : undefined
}

/**
 * Seconds until Jobber's cost bucket holds the points a throttled query asked for
 * (developer.getjobber.com/docs/using_jobbers_api/api_rate_limits): (requested − available) / restore rate.
 */
export function throttleWaitSec(extensions: Json | undefined): number | undefined {
  const cost = extensions?.cost as Json | undefined
  const status = cost?.throttleStatus as Json | undefined
  const requested = Number(cost?.requestedQueryCost)
  const available = Number(status?.currentlyAvailable)
  const rate = Number(status?.restoreRate)
  if (![requested, available, rate].every(Number.isFinite) || rate <= 0) return undefined
  return Math.max(1, Math.ceil((requested - available) / rate))
}

type GraphQL = (token: TokenSource, query: string, variables: Json, what: string) => Promise<Json>

/**
 * One GraphQL request. On HTTP 401 it refreshes the token once and tries again. Jobber answers query errors with
 * HTTP 200 and `errors`: THROTTLED is rate_limited (with the wait its cost bucket needs), an access error is auth, a
 * missing record not_found, anything else invalid.
 */
function graphqlClient({ fetch: doFetch = fetch, timeoutMs = 10_000, api = JOBBER_API }: Options): GraphQL {
  return async (token, query, variables, what) => {
    for (let attempt = 0; ; attempt++) {
      const accessToken = await token(attempt > 0)
      let res: Response
      try {
        res = await doFetch(`${api}${GRAPHQL_PATH}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'x-jobber-graphql-version': JOBBER_GRAPHQL_VERSION,
          },
          body: JSON.stringify({ query, variables }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new AppError('jobber', 'unavailable', `${what} could not reach Jobber`)
      }
      if (res.status === 401 && attempt === 0) continue
      const body = await readBody(res)
      const failed = (message: string) => `${what} failed${message ? `: ${message}` : ''}`
      if (res.status === 401 || res.status === 403)
        throw new AppError('jobber', 'auth', failed(reasonOf(body) ?? ''), res.status)
      if (res.status === 429) throw new AppError('jobber', 'rate_limited', failed(''), res.status, retryAfterOf(res))
      if (res.status >= 500) throw new AppError('jobber', 'unavailable', failed(''), res.status)
      if (!res.ok) throw new AppError('jobber', 'invalid', failed(reasonOf(body) ?? ''), res.status)
      const errors = Array.isArray(body.json.errors) ? (body.json.errors as Json[]) : []
      if (errors.length > 0) {
        const codes = errors.map(e => String((e.extensions as Json | undefined)?.code ?? ''))
        const message = errors
          .map(e => String(e.message ?? ''))
          .join('; ')
          .slice(0, 300)
        if (codes.includes('THROTTLED') || /throttled/i.test(message))
          throw new AppError(
            'jobber',
            'rate_limited',
            failed('throttled'),
            429,
            throttleWaitSec(body.json.extensions as Json | undefined),
          )
        if (
          codes.some(c => /UNAUTHORI[SZ]ED|FORBIDDEN|ACCESS_DENIED/i.test(c)) ||
          /access denied|unauthori[sz]ed|insufficient scope|missing scope/i.test(message)
        )
          throw new AppError('jobber', 'auth', failed(message), 403)
        if (codes.includes('NOT_FOUND') || /not found|could not find/i.test(message))
          throw new AppError('jobber', 'not_found', failed(message), 404)
        throw new AppError('jobber', 'invalid', failed(message))
      }
      return (body.json.data ?? {}) as Json
    }
  }
}

/** A mutation's userErrors as one invalid AppError; nothing when there are none. */
function throwUserErrors(payload: Json | undefined, what: string) {
  const errors = Array.isArray(payload?.userErrors) ? (payload.userErrors as Json[]) : []
  if (errors.length === 0) return
  const message = errors
    .map(e => String(e.message ?? ''))
    .join('; ')
    .slice(0, 300)
  throw new AppError('jobber', 'invalid', `${what} failed: ${message}`)
}

const ACCOUNT_QUERY = 'query LinedeskAccount { account { id name } }'
const DISCONNECT_MUTATION = 'mutation LinedeskDisconnect { appDisconnect { app { name } userErrors { message path } } }'

async function readAccount(graphql: GraphQL, accessToken: string): Promise<AppAccount> {
  const data = await graphql(async () => accessToken, ACCOUNT_QUERY, {}, 'reading the account')
  const account = data.account as Json | undefined
  if (!account?.id) throw new AppError('jobber', 'invalid', 'reading the account returned no account')
  const name = typeof account.name === 'string' && account.name.trim() ? account.name.trim() : String(account.id)
  return { id: String(account.id), name }
}

export function createJobberOAuth({ clientId, clientSecret }: OAuthClient, options: Options = {}): AppOAuth {
  const { fetch: doFetch = fetch, timeoutMs = 8000, api = JOBBER_API } = options
  const graphql = graphqlClient({ ...options, timeoutMs })

  async function tokens(fields: Record<string, string>, what: string): Promise<OAuthTokens> {
    let res: Response
    try {
      res = await doFetch(`${api}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new AppError('jobber', 'unavailable', `${what} could not reach Jobber`)
    }
    const body = await readBody(res)
    if (!res.ok) {
      const reason = reasonOf(body)
      const message = `${what} failed${reason ? `: ${reason}` : ''}`
      // The install's own app was refused, not one account's grant: Server admin's to fix.
      if (JOBBER_CLIENT_REFUSED.test(body.text)) throw new AppError('jobber', 'client', message, res.status)
      if (res.status === 429) throw new AppError('jobber', 'rate_limited', message, res.status, retryAfterOf(res))
      if (res.status >= 500) throw new AppError('jobber', 'unavailable', message, res.status)
      // invalid_grant, "The provided refresh token is not valid.": disconnected in Jobber, rotated away, or expired.
      throw new AppError('jobber', 'auth', message, res.status)
    }
    const accessToken = body.json.access_token
    if (typeof accessToken !== 'string' || !accessToken)
      throw new AppError('jobber', 'invalid', `${what} returned no access token`)
    const expiresIn = Number(body.json.expires_in) || jwtSecondsLeft(accessToken)
    return {
      accessToken,
      refreshToken: typeof body.json.refresh_token === 'string' ? body.json.refresh_token : null,
      expiresAt: expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: typeof body.json.scope === 'string' ? body.json.scope : null,
    }
  }

  return {
    id: 'jobber',
    scopes: JOBBER_SCOPES,
    // appDisconnect cuts the app off the whole Jobber account: never while another connection uses that account.
    grantPerAccount: true,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(`${JOBBER_API}${AUTHORIZE_PATH}`)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
      }).toString()
      return url.toString()
    },
    async exchangeCode({ code, redirectUri }) {
      const granted = await tokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'connect')
      // The account comes with the grant, so a connect that fails later knows whether another connection shares it.
      const account = await readAccount(graphql, granted.accessToken).catch(() => null)
      return { ...granted, account }
    },
    refresh: refreshToken => tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'refresh access'),
    /**
     * Jobber has no token revocation: appDisconnect (with an access token) disconnects the app from the account and
     * invalidates its tokens. The refresh token is used up here, which is fine: it is being given up.
     */
    async revoke(refreshToken) {
      try {
        const { accessToken } = await tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'disconnect')
        const data = await graphql(async () => accessToken, DISCONNECT_MUTATION, {}, 'disconnecting')
        const payload = data.appDisconnect as Json | undefined
        return !!payload && (!Array.isArray(payload.userErrors) || payload.userErrors.length === 0)
      } catch {
        return false
      }
    },
    account: accessToken => readAccount(graphql, accessToken),
  }
}

// --- Clients ------------------------------------------------------------------------------------

const CLIENT_FIELDS = 'id firstName lastName companyName phones { number } emails { address }'

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** The digits of a number as written in Jobber ("(503) 555-0142"), compared on the national number. */
function nationalDigits(number: string, country: CountryCode | undefined): string | null {
  const parsed = parsePhoneNumberFromString(number, country ?? 'US')
  if (parsed?.nationalNumber) return String(parsed.nationalNumber)
  const digits = number.replace(/\D/g, '')
  return digits.length >= 7 ? digits : null
}

const countryOf = (e164: string) => parsePhoneNumberFromString(e164)?.country

/**
 * A client created for a caller with no name has the number as its first name (Jobber needs a name): that counts as
 * empty, so a later call that learns the name fills it.
 */
const placeholderName = (firstName: string | null, lastName: string | null) =>
  !!firstName && !lastName && /^[\d\s()+.-]+$/.test(firstName) && firstName.replace(/\D/g, '').length >= 7

function toContact(row: Json): CrmContact {
  const phones = Array.isArray(row.phones) ? (row.phones as Json[]) : []
  const emails = Array.isArray(row.emails) ? (row.emails as Json[]) : []
  const phone = phones.map(p => text(p.number)).find(Boolean) ?? null
  let firstName = text(row.firstName)
  const lastName = text(row.lastName)
  if (placeholderName(firstName, lastName)) firstName = null
  return {
    id: String(row.id),
    firstName,
    lastName,
    email: emails.map(e => text(e.address)).find(Boolean) ?? null,
    phone,
    company: text(row.companyName),
  }
}

/** Jobber's search is fuzzy: a client counts only if one of its numbers is the caller's. */
function hasNumber(row: Json, e164: string) {
  const want = nationalDigits(e164, undefined)
  const country = countryOf(e164)
  const phones = Array.isArray(row.phones) ? (row.phones as Json[]) : []
  return !!want && phones.some(p => typeof p.number === 'string' && nationalDigits(p.number, country) === want)
}

/** What to search for: Jobber keeps numbers as typed, so the national digits, the national form and E.164. */
export function phoneSearchTerms(e164: string): string[] {
  const parsed = parsePhoneNumberFromString(e164)
  const terms = [parsed?.nationalNumber ? String(parsed.nationalNumber) : null, parsed?.formatNational() ?? null, e164]
  return [...new Set(terms.filter((t): t is string => !!t))]
}

/** The call as a client note: plain text (Jobber notes have no markup), with the link back to the call. */
export function callNoteText(call: FinishedCall): string {
  const parts: string[] = [call.urgent ? `${call.title.trim()} (${call.labels.urgent})` : call.title.trim()]
  if (call.summary.trim()) parts.push(call.summary.trim())
  const steps = call.nextSteps.map(s => s.trim()).filter(Boolean)
  if (steps.length > 0) parts.push([`${call.labels.nextSteps}:`, ...steps.map(s => `- ${s}`)].join('\n'))
  parts.push(`${call.labels.openCall}: ${call.callUrl}`)
  return parts.join('\n\n')
}

function nameInput(fields: Partial<CrmFields>): Json {
  const input: Json = {}
  if (fields.firstName) input.firstName = fields.firstName
  if (fields.lastName) input.lastName = fields.lastName
  if (fields.company) input.companyName = fields.company
  return input
}

export function createJobberCrm(options: Options = {}): CrmProvider {
  const graphql = graphqlClient(options)

  async function search(token: TokenSource, term: string, match: (row: Json) => boolean, what: string) {
    const data = await graphql(
      token,
      `query LinedeskFindClient($term: String!) { clients(searchTerm: $term, first: 20) { nodes { ${CLIENT_FIELDS} } } }`,
      { term },
      what,
    )
    const nodes = Array.isArray(data.clients?.nodes) ? (data.clients.nodes as Json[]) : []
    const found = nodes.find(match)
    return found ? toContact(found) : null
  }

  return {
    app: 'jobber',
    async getContact(token, id) {
      try {
        const data = await graphql(
          token,
          `query LinedeskClient($id: EncodedId!) { client(id: $id) { ${CLIENT_FIELDS} } }`,
          { id },
          'reading the client',
        )
        const client = data.client as Json | null | undefined
        return client?.id ? toContact(client) : null
      } catch (e) {
        if (e instanceof AppError && e.kind === 'not_found') return null
        throw e
      }
    },
    async findContactByPhone(token, e164) {
      for (const term of phoneSearchTerms(e164)) {
        const found = await search(token, term, row => hasNumber(row, e164), 'finding the client by phone')
        if (found) return found
      }
      return null
    },
    findContactByEmail: (token, email) =>
      search(
        token,
        email,
        row =>
          Array.isArray(row.emails) &&
          (row.emails as Json[]).some(e => String(e.address ?? '').toLowerCase() === email.toLowerCase()),
        'finding the client by email',
      ),
    async createContact(token, fields) {
      const input: Json = nameInput(fields)
      // Jobber needs a name or a company: a caller with neither is named by their number until a call says more.
      if (!input.firstName && !input.lastName && !input.companyName && fields.phone)
        input.firstName = parsePhoneNumberFromString(fields.phone)?.formatNational() ?? fields.phone
      if (fields.phone) input.phones = [{ number: fields.phone, primary: true, description: 'MAIN' }]
      if (fields.email) input.emails = [{ address: fields.email, primary: true, description: 'MAIN' }]
      const data = await graphql(
        token,
        `mutation LinedeskCreateClient($input: ClientCreateInput!) { clientCreate(input: $input) { client { ${CLIENT_FIELDS} } userErrors { message path } } }`,
        { input },
        'creating the client',
      )
      const payload = data.clientCreate as Json | undefined
      throwUserErrors(payload, 'creating the client')
      if (!payload?.client?.id) throw new AppError('jobber', 'invalid', 'creating the client returned no client')
      return toContact(payload.client as Json)
    },
    async fillContact(token, id, fields) {
      const input: Json = nameInput(fields)
      if (fields.phone) input.phonesToAdd = [{ number: fields.phone, primary: true, description: 'MAIN' }]
      if (fields.email) input.emailsToAdd = [{ address: fields.email, primary: true, description: 'MAIN' }]
      const data = await graphql(
        token,
        'mutation LinedeskFillClient($id: EncodedId!, $input: ClientEditInput!) { clientEdit(clientId: $id, input: $input) { client { id } userErrors { message path } } }',
        { id, input },
        'updating the client',
      )
      throwUserErrors(data.clientEdit as Json | undefined, 'updating the client')
    },
    async logCall(token, contactId, call) {
      const data = await graphql(
        token,
        'mutation LinedeskNote($id: EncodedId!, $input: ClientCreateNoteInput!) { clientCreateNote(clientId: $id, input: $input) { clientNote { id } userErrors { message path } } }',
        { id: contactId, input: { message: callNoteText(call) } },
        'adding the call note',
      )
      const payload = data.clientCreateNote as Json | undefined
      throwUserErrors(payload, 'adding the call note')
      const noteId = payload?.clientNote?.id
      if (!noteId) throw new AppError('jobber', 'invalid', 'adding the call note returned no note')
      return String(noteId)
    },
  }
}

export function createJobberConnector(options: Options = {}): AppConnector {
  const crm = createJobberCrm(options)
  return {
    id: 'jobber',
    crm: true,
    pushCall: (token, call, progress, pushOptions) => pushCallToCrm(crm, token, call, progress, pushOptions),
  }
}
