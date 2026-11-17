/**
 * Connected apps: business tools a workspace connects by OAuth so finished calls flow into them
 * (docs/crm-sync.md). Every app has an OAuth side and a connector that does the work; vendor HTTP lives
 * only in the app's own file.
 */
export const APP_IDS = ['hubspot', 'slack', 'jobber'] as const
export type AppId = (typeof APP_IDS)[number]

export const APP_LABEL: Record<AppId, string> = { hubspot: 'HubSpot', slack: 'Slack', jobber: 'Jobber' }

export const isAppId = (value: string): value is AppId => (APP_IDS as readonly string[]).includes(value)

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  scope: string | null
  /**
   * Where calls go, when the app gives that with the grant: Slack's incoming webhook (a secret URL) and the channel
   * the member picked on Slack's consent page.
   */
  webhook?: { url: string; channel: string } | null
  /** The account, when the token answer names it (Slack's workspace); else `account()` asks the app. */
  account?: AppAccount | null
}

export type OAuthClient = { clientId: string; clientSecret: string }

/** The account a grant belongs to, as the app names it (a HubSpot portal, a Slack workspace, a Jobber account). */
export type AppAccount = { id: string; name: string }

/** The OAuth side of an app: consent URL, code exchange, refresh, revoke, and whose account it is. */
export interface AppOAuth {
  readonly id: AppId
  readonly scopes: readonly string[]
  /**
   * The grant is one per account at the app, not one per connect (a Slack bot token is the same for every install of
   * the app in a workspace): withdrawing it would cut every connection to that account, so it is withdrawn only when
   * no other connection uses the account.
   */
  readonly grantPerAccount?: boolean
  authorizeUrl(params: { redirectUri: string; state: string }): string
  exchangeCode(params: { code: string; redirectUri: string }): Promise<OAuthTokens>
  refresh(refreshToken: string): Promise<OAuthTokens>
  /** Withdraws the grant at the app. Returns false when that did not work. */
  revoke(refreshToken: string): Promise<boolean>
  /**
   * Removes the app from the whole account at the app (HubSpot: the app leaves the portal's Connected apps), then
   * withdraws the grant. Only for a disconnect, and only when no other connection uses the account: every grant of
   * the account ends with it. Returns false when that did not work. Apps without it are only revoked.
   */
  uninstall?(refreshToken: string): Promise<boolean>
  account(accessToken: string): Promise<AppAccount>
}

/**
 * auth: the grant is gone or lacks a scope, someone must connect again (no retry).
 * rate_limited / unavailable: try again later. invalid: the app refused the data (no retry helps).
 * channel_not_found / channel_archived: the Slack channel calls go to is gone or archived (connect again, no retry).
 * client: the app refused the install's own client ID or secret (Server admin › Providers), not one account's grant.
 */
export type AppErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid'
  | 'not_found'
  | 'channel_not_found'
  | 'channel_archived'
  | 'client'

export class AppError extends Error {
  readonly app: AppId
  readonly kind: AppErrorKind
  readonly status: number | undefined
  /** rate_limited: the seconds the app asked to wait (Retry-After), when it said. */
  readonly retryAfterSec: number | undefined
  constructor(app: AppId, kind: AppErrorKind, message: string, status?: number, retryAfterSec?: number) {
    super(`${APP_LABEL[app]}: ${message}`)
    this.name = 'AppError'
    this.app = app
    this.kind = kind
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/**
 * The app refused a refresh because the grant no longer exists (HubSpot: the app was uninstalled in the portal). An
 * `auth` error like any refused grant, but certain: not the install's client being refused (`client`), not a passing
 * failure. The stored tokens are worthless; the caller removes the connection.
 */
export class GrantRevoked extends AppError {
  constructor(app: AppId, message: string, status?: number) {
    super(app, 'auth', message, status)
    this.name = 'GrantRevoked'
  }
}

export const retryable = (err: unknown) =>
  !(err instanceof AppError) || err.kind === 'rate_limited' || err.kind === 'unavailable'

/**
 * A push the connection's settings said not to send, found out at the app: `no_contact`, no contact matched the
 * caller and creating contacts is off. Not a failure: nothing is retried or counted against the connection.
 */
export class PushSkipped extends Error {
  readonly reason: 'no_contact'
  constructor(reason: 'no_contact') {
    super(`push skipped: ${reason}`)
    this.name = 'PushSkipped'
    this.reason = reason
  }
}

/** Gives a valid access token; `forceRefresh` after the app answered 401 with the current one. */
export type TokenSource = (forceRefresh?: boolean) => Promise<string>

/** A connection's access as a connector gets it: the token source, and for Slack the stored incoming webhook URL. */
export type AppAccess = TokenSource & { webhookUrl?: () => Promise<string> }

/** One finished phone call as the apps get it. Text is already in the workspace's language. */
export type FinishedCall = {
  callId: string
  direction: 'in' | 'out'
  /** The other party's number (E.164). */
  callerNumber: string
  /** The business's number (E.164), when known. */
  businessNumber: string | null
  startedAt: string
  durationSec: number
  title: string
  summary: string
  nextSteps: string[]
  callUrl: string
  caller: { name: string | null; email: string | null; company: string | null; phone: string }
  /** The record this caller is linked to in the app, from an earlier push. */
  linkedRecordId: string | null
  /** The summary marked the call urgent. */
  urgent: boolean
  /**
   * Linedesk's words around the call, in the workspace's language (apps/api/src/emails/app-push-text.ts). `when`:
   * the start, written out, for apps that cannot show a date in each reader's own zone and language.
   */
  labels: { nextSteps: string; openCall: string; caller: string; number: string; urgent: string; when: string }
}

/** recordId: the app's record for the caller (stored as the link). activityId: the logged call. */
export type PushResult = { recordId: string | null; activityId: string }

/**
 * Called as soon as a push has made something at the app, before it goes on, so the caller can save it and a retry
 * after a later failure reuses it instead of making it again: the caller's record (found or created), the logged call.
 */
export type PushProgress = {
  onRecord?(recordId: string): Promise<void>
  onLogged?(activityId: string): Promise<void>
}

/**
 * What a push may do at the app: the connection's switches (APP_SETTINGS in @linedesk/actions). createContacts: add a
 * caller with no record (else PushSkipped `no_contact`); fillFields: fill empty fields of an existing record.
 */
export type PushOptions = { createContacts: boolean; fillFields: boolean }

export const DEFAULT_PUSH_OPTIONS: PushOptions = { createContacts: true, fillFields: true }

/** What a connected app does with a finished call. Throws PushSkipped when `options` say not to send it. */
export interface AppConnector {
  readonly id: AppId
  /** Files each call under the caller's record (a CRM): a call with no number or email to find them cannot go. */
  readonly crm: boolean
  pushCall(access: AppAccess, call: FinishedCall, progress?: PushProgress, options?: PushOptions): Promise<PushResult>
}

export type Json = Record<string, any>
