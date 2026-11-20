// Microsoft Graph mail adapter (Outlook, Microsoft 365; read only) and the OAuth of the install's Microsoft app (the
// sign-in and calendar app: Mail.Read is a plain delegated permission, no security assessment). Plain fetch.
// https://learn.microsoft.com/graph/api/resources/message
import {
  type AccessTokenSource,
  addressOf,
  createHttp,
  type Json,
  MailError,
  type MailErrorKind,
  type MailMessage,
  type MailOAuth,
  type MailProvider,
  type OAuthClient,
  tokenRequest,
} from './provider.ts'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const login = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`

/** offline_access for a refresh token, User.Read for the account's address, Mail.Read for the messages. */
export const MICROSOFT_MAIL_SCOPES = ['openid', 'email', 'offline_access', 'User.Read', 'Mail.Read'] as const

/** Folders whose messages are not the business's mail. */
const SKIPPED_FOLDERS = ['junkemail', 'deleteditems', 'drafts'] as const

const reasonOf = (body: Json) => body.error?.message as string | undefined

export function graphMailForbidden(body: Json): { kind: MailErrorKind; message?: string } {
  const code = String(body.error?.code ?? '')
  if (/quota|throttl|toomany/i.test(code)) return { kind: 'rate_limited' }
  if (/accessdenied|authorization|insufficient/i.test(code)) return { kind: 'auth' }
  return { kind: 'invalid' }
}

export type GraphMailOptions = {
  accessToken: AccessTokenSource
  /** The mailbox's own address: a message from it is a support answer. */
  accountEmail: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createGraphMail({
  accessToken,
  accountEmail,
  fetch: doFetch = fetch,
  timeoutMs = 8000,
}: GraphMailOptions): MailProvider {
  const get = createHttp({
    provider: 'microsoft',
    accessToken,
    fetch: doFetch,
    timeoutMs,
    reasonOf,
    forbidden: graphMailForbidden,
  })
  const own = accountEmail.toLowerCase()
  let skipped: Promise<Set<string>> | undefined
  /** The ids of junk, deleted items and drafts, read once per adapter. A folder the account lacks is left out. */
  const skippedFolders = () =>
    (skipped ??= Promise.all(
      SKIPPED_FOLDERS.map(name =>
        get('read a mail folder', `${GRAPH}/me/mailFolders/${name}?$select=id`).then(
          f => String(f.id),
          e => {
            if (e instanceof MailError && e.kind === 'not_found') return ''
            throw e
          },
        ),
      ),
    ).then(ids => new Set(ids.filter(Boolean))))

  return {
    name: 'microsoft',

    async listMessages({ after, pageToken, max = 100 } = {}) {
      let url: string
      if (pageToken) {
        // The token is Graph's own next link; only ever followed on Graph's message listing.
        if (!pageToken.startsWith(`${GRAPH}/me/messages?`))
          throw new MailError('microsoft', 'invalid', 'list messages failed: not a page of this mailbox')
        url = pageToken
      } else {
        const since = new Date(after ? Date.parse(after) : 0).toISOString()
        // Graph wants the $orderby property first in $filter.
        const params = new URLSearchParams({
          $select: 'id,conversationId,parentFolderId',
          $top: String(Math.min(Math.max(max, 1), 1000)),
          $filter: `receivedDateTime ge ${since}`,
          $orderby: 'receivedDateTime desc',
        })
        url = `${GRAPH}/me/messages?${params}`
      }
      const [body, skip] = await Promise.all([get('list messages', url), skippedFolders()])
      return {
        messages: ((body.value ?? []) as Json[])
          .filter(m => !skip.has(String(m.parentFolderId)))
          .map(m => ({ id: String(m.id), threadId: String(m.conversationId ?? m.id) })),
        nextPageToken: typeof body['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : null,
      }
    },

    async getMessage(id) {
      let body: Json
      try {
        const select = 'id,conversationId,from,toRecipients,subject,sentDateTime,receivedDateTime,body'
        body = await get('read a message', `${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${select}`, {
          Prefer: 'outlook.body-content-type="text"',
        })
      } catch (e) {
        if (e instanceof MailError && e.kind === 'not_found') return null
        throw e
      }
      const from = addressOf(String(body.from?.emailAddress?.address ?? ''))
      const message: MailMessage = {
        id: String(body.id),
        threadId: String(body.conversationId ?? body.id),
        from,
        to: ((body.toRecipients ?? []) as Json[])
          .map(r => addressOf(String(r.emailAddress?.address ?? '')))
          .filter(a => a.includes('@')),
        subject: String(body.subject ?? ''),
        sentAt: new Date(body.sentDateTime ?? body.receivedDateTime ?? 0).toISOString(),
        fromMailbox: from === own,
        text: String(body.body?.content ?? '').trim(),
      }
      return message
    },
  }
}

export type MicrosoftMailOAuthOptions = OAuthClient & { tenantId?: string }

const READ_SCOPE = /(^|\s|\/)mail\.read(write)?(\s|$)/i

export function createMicrosoftMailOAuth(
  { clientId, clientSecret, tenantId = 'common' }: MicrosoftMailOAuthOptions,
  { fetch: doFetch = fetch, timeoutMs = 8000 } = {},
): MailOAuth {
  const base = login(tenantId)
  const scope = MICROSOFT_MAIL_SCOPES.join(' ')
  return {
    name: 'microsoft',
    scopes: MICROSOFT_MAIL_SCOPES,

    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(`${base}/authorize`)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope,
        prompt: 'select_account',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },

    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      tokenRequest(
        'microsoft',
        'connect',
        `${base}/token`,
        {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
          scope,
        },
        doFetch,
        timeoutMs,
      ),

    // Microsoft may hand out a new refresh token with every refresh; the caller keeps the newest.
    refresh: refreshToken =>
      tokenRequest(
        'microsoft',
        'refresh access',
        `${base}/token`,
        {
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          scope,
        },
        doFetch,
        timeoutMs,
      ),

    // The identity platform has no endpoint to revoke one app's refresh token: deleting it is all Linedesk can do.
    revoke: async () => false,

    async accountEmail(accessToken) {
      const res = await doFetch(`${GRAPH}/me?$select=mail,userPrincipalName`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = (await res.json().catch(() => ({}))) as Json
      const email = body.mail ?? body.userPrincipalName
      if (!res.ok || typeof email !== 'string')
        throw new Error(`Microsoft 365: reading the account's email failed (${res.status})`)
      return email
    },

    grantsMailRead: granted => granted === null || READ_SCOPE.test(granted),
  }
}
