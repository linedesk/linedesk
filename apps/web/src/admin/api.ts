// The admin area talks to the API directly. Its rows cross workspaces, so they are not in the
// local store, and its writes skip the outbox on purpose: an outbox entry is kept in IndexedDB,
// and a provider key must never be stored in the browser.
import { StepUpRequired, stepUpOf, withPasskeyStepUp } from './PasskeyStepUp.tsx'
import {
  type BrandingInput,
  type MembershipRole,
  type ProviderCategory,
  type ProviderFailure,
  type ProviderName,
  type ProviderTestData,
  providerCategories,
  providers as providerRegistry,
} from '@linedesk/actions'
import type { AdminSecondFactor } from '../auth.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'

export type AdminWorkspace = {
  id: string
  name: string
  created_at: string
  disabled_at: string | null
  members: number
  /** Members without another workspace (instance admins aside): deleting the workspace deletes their accounts. */
  members_only_here: number
  /** Every call it has, sample and test calls included: what deleting it removes. */
  calls_total: number
  contacts: number
  phone_numbers: string[]
  calls_30d: number
  last_call_at: string | null
  minutes_this_month: number
  /** The estimated cost of this UTC month's calls, the spending cap's measure. */
  cost_this_month: number
  /** null: no monthly spending cap. */
  spending_cap_usd: number | null
}

export type AdminUser = {
  id: string
  name: string
  email: string
  created_at: string
  disabled_at: string | null
  last_sign_in_at: string | null
  instance_admin: boolean
  instance_admin_by_env: boolean
  workspaces: { id: string; name: string; role: string; member_id: string }[]
  /** Pending invitations to the user's address, from any workspace. */
  invitations: { id: string; workspace_id: string; workspace_name: string; role: string; expires_at: string }[]
  /** Their passkeys (absent from an older API): an instance admin's become their second factor. */
  passkeys?: { name: string | null; device_type: string; created_at: string | null }[]
}

export type WorkspaceMember = {
  member_id: string
  user_id: string
  name: string
  email: string
  role: string
  joined_at: string
}
export type WorkspaceInvitation = {
  id: string
  email: string
  role: string
  invited_by: string
  expires_at: string
  expired: boolean
}
export type WorkspaceMembers = { members: WorkspaceMember[]; invitations: WorkspaceInvitation[] }

export type UsageRow = {
  workspace_id: string
  workspace_name: string | null
  month: string
  calls: number
  minutes: number
}

export type ProviderField = {
  field: string
  label: string
  secret: boolean
  /** What an empty field means, e.g. the default model. */
  hint: string | null
  source: 'app' | 'env' | null
  last4: string | null
  value: string | null
  updated_at: string | null
  updated_by: { id: string; name: string } | null
}
export type ProviderStatus = {
  provider: ProviderName
  label: string
  category: ProviderCategory
  fields: ProviderField[]
}
/** Per category: the provider in use (null: none set up) and whether an admin picked it. */
export type ActiveProviders = Record<ProviderCategory, { provider: ProviderName | null; chosen: boolean }>

export type ServiceStatus = { ok: boolean; message: string }

export type AdminOverview = {
  calls: { today: number; last7d: number; month: number }
  minutes: { today: number; last7d: number; month: number }
  costs: {
    category: ProviderCategory
    provider: ProviderName | null
    label: string | null
    minutes7d: number
    cost7d: number
    costMonth: number
  }[]
  workspaces: { total: number; disabled: number; new7d: number }
  users: { total: number; disabled: number; new7d: number }
  /** Providers failing now (absent from an older API). */
  failures?: ProviderFailure[]
}
export type AdminHealth = Record<'api' | 'readSync' | 'livekit' | 'sip' | 'agent' | 'email', ServiceStatus>
export type LivekitStatus = { url: string | null; server: ServiceStatus; sip: ServiceStatus }

export type AdminData = {
  workspaces: AdminWorkspace[]
  users: AdminUser[]
  usage: UsageRow[]
  usageMonths: number
  providers: ProviderStatus[]
  activeProviders: ActiveProviders
  canStoreKeys: boolean
  /** Providers failing now: quota used up, key rejected (the API's provider_failures). */
  providerFailures: ProviderFailure[]
}

/** Thrown when the admin area's sign-in has run out (more than 1 hour, 12 with a passkey) or the email is unconfirmed. */
export class AdminSignInRequired extends Error {
  readonly state: AdminSecondFactor
  constructor(message: string, state: AdminSecondFactor) {
    super(message)
    this.state = state
  }
}

let onSignInRequired: ((state: AdminSecondFactor) => void) | null = null

/**
 * The admin area listens here: once any admin request says the session no longer opens Admin, the
 * whole area turns into "Sign in again for Admin" instead of a "Try again" that cannot work.
 */
export function watchAdminSignIn(listener: (state: AdminSecondFactor) => void): () => void {
  onSignInRequired = listener
  return () => {
    if (onSignInRequired === listener) onSignInRequired = null
  }
}

async function body<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: string; code?: unknown; stepUp?: unknown; secondFactor?: unknown })
    | null
  if (json?.code === 'SECOND_FACTOR_REQUIRED') {
    const state: AdminSecondFactor = json.secondFactor === 'email' ? 'email' : 'confirm'
    onSignInRequired?.(state)
    throw new AdminSignInRequired(json.error ?? 'Sign in again to use the admin area.', state)
  }
  const stepUp = stepUpOf(json)
  if (stepUp) throw new StepUpRequired(json?.error ?? 'Confirm with your passkey.', stepUp)
  if (!res.ok || !json) throw new Error(json?.error ?? `The server answered ${res.status}`)
  return json
}

/** Admin requests go ahead of the read sync's when the browser queues requests. */
const HIGH = { priority: 'high' } as RequestInit
const get = async <T>(path: string) => body<T>(await fetch(path, { ...HIGH, credentials: 'include' }))

/** Cache keys (cachedQuery.ts), kept in memory only: admin rows cross workspaces and are not stored in the browser. */
export const ADMIN_DATA = 'admin.data'
export const ADMIN_HEALTH = 'admin.health'

/**
 * Whether this build of the app knows a provider the API lists. While an update runs (or in a tab opened before it),
 * the API can be newer than the page: a provider or category the page has no registry entry for is left out instead
 * of breaking the page.
 */
const isKnownProvider = (p: ProviderStatus) => p.provider in providerRegistry && p.category in providerCategories

export async function loadAdminData(): Promise<AdminData> {
  const [w, u, usage, p] = await Promise.all([
    get<{ workspaces: AdminWorkspace[] }>('/v1/admin/workspaces'),
    get<{ users: AdminUser[] }>('/v1/admin/users'),
    get<{ months: number; usage: UsageRow[] }>('/v1/admin/usage'),
    get<{ can_store: boolean; active: ActiveProviders; providers: ProviderStatus[]; failures?: ProviderFailure[] }>(
      '/v1/admin/providers',
    ),
  ])
  return {
    workspaces: w.workspaces,
    users: u.users,
    usage: usage.usage,
    usageMonths: usage.months,
    providers: p.providers.filter(isKnownProvider),
    activeProviders: p.active,
    canStoreKeys: p.can_store,
    providerFailures: (p.failures ?? []).filter(f => f.provider in providerRegistry),
  }
}

type AdminInputs = {
  'provider.setKeys': { provider: ProviderName; values: Record<string, string> }
  'provider.clearKeys': { provider: ProviderName }
  'provider.setActive': { category: ProviderCategory; provider: ProviderName | null }
  'provider.test': { provider: ProviderName }
  'user.invite': { email: string; name: string; admin?: boolean }
  'user.disable': { userId: string }
  'user.enable': { userId: string }
  'workspace.disable': { workspaceId: string }
  'workspace.enable': { workspaceId: string }
  'workspace.delete': { workspaceId: string; name: string; keepUsers?: boolean }
  'workspace.setSpendingCap': { workspaceId: string; capUsd: number | null }
  'instanceAdmin.grant': { userId: string }
  'instanceAdmin.revoke': { userId: string }
  'user.resetPasskeys': { userId: string }
  'membership.add': { userId: string; workspaceId: string; role: MembershipRole }
  'membership.setRole': { memberId: string; role: MembershipRole }
  'membership.remove': { memberId: string }
  'invitation.revoke': { invitationId: string }
  'invitation.resend': { invitationId: string }
  'voiceCloning.get': Record<string, never>
  'voiceCloning.set': { on: boolean }
  'branding.set': BrandingInput
}

/**
 * Runs an admin action through the registry. Throws with the server's reason when it is rejected;
 * when it needs a passkey sign-in, asks for one and runs again (PasskeyStepUp.tsx).
 */
export function runAdmin<N extends keyof AdminInputs>(name: N, input: AdminInputs[N]) {
  return withPasskeyStepUp(async () => {
    const res = await fetch(`/v1/actions/${name}`, {
      ...HIGH,
      method: 'POST',
      credentials: 'include',
      headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    return (await body<{ data?: Record<string, unknown> }>(res)).data ?? {}
  }, stepUpLabel(name))
}

/** What the passkey dialog says it confirms. */
const stepUpLabels: Partial<Record<keyof AdminInputs, string>> = {
  'instanceAdmin.grant': 'make an instance admin',
  'instanceAdmin.revoke': 'remove an instance admin',
  'user.resetPasskeys': 'reset passkeys',
  'user.invite': 'invite an instance admin',
  'user.disable': 'disable an admin',
  'user.enable': 'enable an admin',
  'membership.add': 'add an admin to a workspace',
  'membership.setRole': "change an admin's role",
  'membership.remove': 'remove an admin from a workspace',
  'workspace.delete': 'delete a workspace',
}
export const stepUpLabel = (name: keyof AdminInputs) => stepUpLabels[name] ?? 'this admin change'

export const testProvider = async (provider: ProviderName) =>
  (await runAdmin('provider.test', { provider })) as ProviderTestData

/** LiveKit is part of the install: its status is read-only. Can take a few seconds when the server is down. */
export const loadLivekitStatus = async () => (await get<{ livekit: LivekitStatus }>('/v1/admin/system')).livekit

export const loadWorkspaceMembers = (workspaceId: string) =>
  get<WorkspaceMembers>(`/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/members`)

export const loadOverview = () => get<AdminOverview>('/v1/admin/overview')

/** GET /v1/admin/latency (apps/api/src/reply-latency.ts): reply delay per pipeline, split by where the time goes. */
export type Percentiles = { p50: number | null; p90: number | null }
export type PipelineLatency = {
  pipeline: 'cascaded' | 'realtime'
  replies: number
  providers: { turn?: string; model?: string; voice?: string }
  turn: Percentiles
  model: Percentiles
  voice: Percentiles
  server: Percentiles
  total: Percentiles
  phone: Percentiles & { calls: number }
}
export const loadLatency = () => get<{ days: number; pipelines: PipelineLatency[] }>('/v1/admin/latency')

export type AuditKind = 'sign_in' | 'account' | 'admin' | 'team' | 'impersonation' | 'keys' | 'integrations'
/** One entry of GET /v1/admin/audit (apps/api/src/audit.ts). */
export type AuditEntry = {
  id: string
  at: string
  kind: AuditKind
  what: string
  method: string | null
  actor: { id: string | null; email: string | null; name: string | null }
  impersonatedBy: { id: string; email: string | null } | null
  workspace: { id: string; name: string | null } | null
  /** Whom a team or membership change was about. */
  subject: { email: string | null } | null
  input: unknown
  refused: boolean
  ipAddress: string | null
}
/** `to` is exclusive (the day after the last day shown); `before` is the previous page's `next`. */
export type AuditFilter = {
  kind?: AuditKind
  who?: string
  workspace?: string
  from?: string
  to?: string
  before?: string
}

export const loadAudit = (filter: AuditFilter) =>
  get<{ entries: AuditEntry[]; next: string | null }>(
    `/v1/admin/audit?${new URLSearchParams(filter as Record<string, string>)}`,
  )
/** Waits for LiveKit and the mail server: can take a few seconds. */
export const loadHealth = () => get<AdminHealth>('/v1/admin/health')
