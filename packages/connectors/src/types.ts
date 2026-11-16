/**
 * Connected apps: business tools a workspace connects by OAuth so finished calls flow into them
 * (docs/crm-sync.md). Every app has an OAuth side and a connector that does the work; vendor HTTP lives
 * only in the app's own file.
 */
export const APP_IDS = ['hubspot'] as const
export type AppId = (typeof APP_IDS)[number]

export const APP_LABEL: Record<AppId, string> = { hubspot: 'HubSpot' }

export const isAppId = (value: string): value is AppId => (APP_IDS as readonly string[]).includes(value)

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  scope: string | null
}

export type OAuthClient = { clientId: string; clientSecret: string }

/** The account a grant belongs to, as the app names it (a HubSpot portal). */
export type AppAccount = { id: string; name: string }

/** The OAuth side of an app: consent URL, code exchange, refresh, revoke, and whose account it is. */
export interface AppOAuth {
  readonly id: AppId
  readonly scopes: readonly string[]
  authorizeUrl(params: { redirectUri: string; state: string }): string
  exchangeCode(params: { code: string; redirectUri: string }): Promise<OAuthTokens>
  refresh(refreshToken: string): Promise<OAuthTokens>
  /** Withdraws the grant at the app. Returns false when that did not work. */
  revoke(refreshToken: string): Promise<boolean>
  account(accessToken: string): Promise<AppAccount>
}

/**
 * auth: the grant is gone or lacks a scope, someone must connect again (no retry).
 * rate_limited / unavailable: try again later. invalid: the app refused the data (no retry helps).
 */
export type AppErrorKind = 'auth' | 'rate_limited' | 'unavailable' | 'invalid' | 'not_found'

export class AppError extends Error {
  readonly app: AppId
  readonly kind: AppErrorKind
  readonly status: number | undefined
  constructor(app: AppId, kind: AppErrorKind, message: string, status?: number) {
    super(`${APP_LABEL[app]}: ${message}`)
    this.name = 'AppError'
    this.app = app
    this.kind = kind
    this.status = status
  }
}

export const retryable = (err: unknown) =>
  !(err instanceof AppError) || err.kind === 'rate_limited' || err.kind === 'unavailable'

/** Gives a valid access token; `forceRefresh` after the app answered 401 with the current one. */
export type TokenSource = (forceRefresh?: boolean) => Promise<string>

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
  labels: { nextSteps: string; openCall: string }
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

/** What a connected app does with a finished call. */
export interface AppConnector {
  readonly id: AppId
  pushCall(token: TokenSource, call: FinishedCall, progress?: PushProgress): Promise<PushResult>
}

export type Json = Record<string, any>
