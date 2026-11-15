// The admin area talks to the API directly. Its rows cross workspaces, so they are not in the
// local store, and its writes skip the outbox on purpose: an outbox entry is kept in IndexedDB,
// and a provider key must never be stored in the browser.
import { StepUpRequired, stepUpOf, withPasskeyStepUp } from './PasskeyStepUp.tsx'
import {
  type AgentSetupState,
  type BrandingInput,
  type InstallSetupState,
  type InstallStep,
  type MembershipRole,
  type ProviderCategory,
  type ProviderFailure,
  type ProviderName,
  type ProviderTestData,
  providerCategories,
  type StatusGroups,
  type StatusInput,
  type StoredTest,
  type TryOutKind,
  type VoicePipelinePolicy,
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
  /** Their profile picture, null without one (absent from an older API). */
  avatar_url?: string | null
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

/**
 * Server admin › Users filter. `noWorkspace`: accounts without a membership (kept on a removal or delete, or older
 * self-signed-up ones), so the admin can decide about each; nothing is deleted on its own (Janik, 2026-11-15; A9).
 */
export type UserFilter = 'all' | 'noWorkspace'
export const filterUsers = (users: readonly AdminUser[], filter: UserFilter): AdminUser[] =>
  filter === 'noWorkspace' ? users.filter(u => !u.workspaces.length) : [...users]

export type WorkspaceMember = {
  member_id: string
  user_id: string
  name: string
  email: string
  role: string
  joined_at: string
  /** Their profile picture, null without one (absent from an older API). */
  avatar_url?: string | null
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
  /** The stored key in effect is this provider's (one-key mode: the realtime model's key). */
  key_from?: ProviderName | null
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
export type HealthPart = 'api' | 'readSync' | 'livekit' | 'sip' | 'agent' | 'email'
export type AdminHealth = Record<HealthPart, ServiceStatus> & {
  /** LiveKit is set in .env at all (absent from an older API: assumed set). */
  livekitConfigured?: boolean
}
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
  /** The last test of each provider's keys in effect (provider_tests): every screen starts from it. */
  tests: Partial<Record<ProviderName, StoredTest>>
  /** What the status needs besides the providers: how assistants answer, email to the log, the dev carrier. */
  statusContext: StatusContext
}
export type StatusContext = Pick<StatusInput, 'assistantPipelines' | 'emailToLog' | 'devCarrier' | 'signInPending'>

/** Thrown when the admin area's sign-in has run out (more than 1 hour, 12 with a passkey) or the email is unconfirmed. */
export class AdminSignInRequired extends Error {
  readonly state: AdminSecondFactor
  constructor(message: string, state: AdminSecondFactor) {
    super(message)
    this.state = state
  }
}

const signInListeners = new Set<(state: AdminSecondFactor) => void>()

/**
 * The admin area and the setup pages listen here: once any admin request says the session no longer opens Admin,
 * the page turns into the passkey check (SecondFactorPrompt) instead of an error or a "Try again" that cannot work.
 */
export function watchAdminSignIn(listener: (state: AdminSecondFactor) => void): () => void {
  signInListeners.add(listener)
  return () => {
    signInListeners.delete(listener)
  }
}

async function body<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: string; code?: unknown; stepUp?: unknown; secondFactor?: unknown })
    | null
  if (json?.code === 'SECOND_FACTOR_REQUIRED') {
    const state: AdminSecondFactor =
      json.secondFactor === 'email' || json.secondFactor === 'enrol' ? json.secondFactor : 'confirm'
    for (const listener of signInListeners) listener(state)
    throw new AdminSignInRequired(json.error ?? 'Server admin needs your passkey.', state)
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
    get<{
      can_store: boolean
      active: ActiveProviders
      providers: ProviderStatus[]
      failures?: ProviderFailure[]
      tests?: Partial<Record<ProviderName, StoredTest>>
      status?: StatusContext
    }>('/v1/admin/providers'),
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
    tests: p.tests ?? {},
    statusContext: p.status ?? {},
  }
}

type AdminInputs = {
  'provider.setKeys': { provider: ProviderName; values: Record<string, string> }
  'provider.clearKeys': { provider: ProviderName }
  'provider.setActive': { category: ProviderCategory; provider: ProviderName | null }
  'provider.test': { provider: ProviderName; free?: boolean }
  'provider.connectOneKey': { apiKey: string }
  'user.invite': { email: string; name: string; admin?: boolean; workspaceId?: string | null; role?: MembershipRole }
  'user.disable': { userId: string }
  'user.enable': { userId: string }
  'workspace.disable': { workspaceId: string }
  'workspace.enable': { workspaceId: string }
  'workspace.delete': {
    workspaceId: string
    name: string
    keepAccounts?: boolean
    /** @deprecated The old name of keepAccounts, sent with the same value for one release (an older API reads it). */
    keepUsers?: boolean
  }
  'workspace.setSpendingCap': { workspaceId: string; capUsd: number | null }
  'instanceAdmin.grant': { userId: string }
  'instanceAdmin.revoke': { userId: string }
  'user.resetPasskeys': { userId: string }
  'user.issuePasskeyEnrolment': { userId: string }
  'membership.add': { userId: string; workspaceId: string; role: MembershipRole }
  'membership.setRole': { memberId: string; role: MembershipRole }
  'membership.remove': { memberId: string; keepAccount?: boolean }
  'invitation.revoke': { invitationId: string }
  'invitation.resend': { invitationId: string }
  'outboundCountries.get': Record<string, never>
  'outboundCountries.set': { countries: string[]; confirmHighRisk?: string[] }
  'voiceCloning.get': Record<string, never>
  'voiceCloning.set': { on: boolean }
  'voicePipelinePolicy.get': Record<string, never>
  'voicePipelinePolicy.set': { policy: VoicePipelinePolicy }
  'setupEmails.get': Record<string, never>
  'setupEmails.set': { on: boolean }
  'workspace.create': { name: string; timeZone?: string; owner: { email: string; name?: string } }
  'branding.set': BrandingInput
  'agentSetup.createKey': Record<string, never>
  'agentSetup.revoke': Record<string, never>
  'install.setProgress': {
    step?: InstallStep
    skip?: InstallStep
    setAside?: boolean
    finished?: boolean
    manual?: boolean
  }
  'provider.tryOut': { kind: TryOutKind; areaCode?: string }
  'provider.confirmEmail': { code: string }
}

/**
 * Runs an admin action through the registry. Throws with the server's reason when it is rejected;
 * when it needs a passkey sign-in, asks for one and runs again (PasskeyStepUp.tsx). `what`: what the dialog says it confirms.
 */
export function runAdmin<N extends keyof AdminInputs>(name: N, input: AdminInputs[N], what = stepUpLabel(name, input)) {
  return withPasskeyStepUp(() => runAdminOnce(name, input), what)
}

/**
 * Runs an admin action once, without the passkey dialog: a step-up refusal throws StepUpRequired. runAdmin wraps it.
 */
export async function runAdminOnce<N extends keyof AdminInputs>(name: N, input: AdminInputs[N]) {
  const res = await fetch(`/v1/actions/${name}`, {
    ...HIGH,
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await body<{ data?: Record<string, unknown> }>(res)).data ?? {}
}

/** What the passkey dialog says it confirms. */
const stepUpLabels: Partial<Record<keyof AdminInputs, string>> = {
  'instanceAdmin.grant': 'make an instance admin',
  'instanceAdmin.revoke': 'remove an instance admin',
  'user.resetPasskeys': 'reset passkeys',
  'user.issuePasskeyEnrolment': 'issue a passkey enrolment code',
  'user.invite': 'add a user',
  'user.disable': 'disable an admin',
  'user.enable': 'enable an admin',
  'membership.add': 'add someone to a workspace',
  'membership.setRole': 'change a role',
  'membership.remove': 'remove an admin from a workspace',
  'workspace.delete': 'delete a workspace',
  'workspace.create': 'create a workspace and give it an owner',
  'provider.setKeys': 'save email or sign-in keys',
  'provider.clearKeys': 'disconnect email or sign-in',
  'outboundCountries.set': 'change where calls may go',
}
/** What the passkey dialog says it confirms; a workspace about to be deleted by its name (LIN-161). */
export function stepUpLabel<N extends keyof AdminInputs>(name: N, input?: AdminInputs[N]): string {
  if (name === 'workspace.delete') {
    const workspace = (input as AdminInputs['workspace.delete'] | undefined)?.name?.trim()
    if (workspace) return `delete workspace ${workspace}`
  }
  return stepUpLabels[name] ?? 'this admin change'
}

/** The providers that use this one's stored key (one-key mode): Disconnect ends them too. */
export const keyUsersOf = (providers: readonly ProviderStatus[], provider: ProviderName) =>
  providers.filter(p => p.fields.some(f => f.key_from === provider))

/** provider.test; `free`: only what costs nothing (the page's own checks and Test again). */
export const testProvider = async (provider: ProviderName, { free = false }: { free?: boolean } = {}) =>
  (await runAdmin('provider.test', { provider, ...(free ? { free } : {}) })) as ProviderTestData

/** LiveKit is part of the install: its status is read-only. Can take a few seconds when the server is down. */
export const loadLivekitStatus = async () => (await get<{ livekit: LivekitStatus }>('/v1/admin/system')).livekit

export const loadWorkspaceMembers = (workspaceId: string) =>
  get<WorkspaceMembers>(`/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/members`)

export const loadOverview = () => get<AdminOverview>('/v1/admin/overview')

/** GET /v1/admin/agent-setup (apps/api/src/agent-setup.ts): the setup key in use (never the key) and the agent's progress. */
export const loadAgentSetup = (workspaceId?: string | null) =>
  get<AgentSetupState>(
    workspaceId ? `/v1/admin/agent-setup?workspace=${encodeURIComponent(workspaceId)}` : '/v1/admin/agent-setup',
  )
/** Install setup by hand (InstallSetup.tsx): where it is, and whether a saved sign-in change waits for a restart. */
export const loadInstallSetup = () => get<InstallSetupState>('/v1/admin/install-setup')

/**
 * GET /v1/admin/onboarding (apps/api/src/setup-emails.ts): workspaces without a real call `days` after sign-up, and how many
 * signed up that long ago at all (none on a new install).
 */
export type AtRiskWorkspace = {
  id: string
  name: string
  signed_up_at: string
  onboarding_step: string | null
  owner_email: string | null
  /** Each setup milestone reached, with when. */
  milestones: Record<string, string>
  /** Setup emails sent, with when. */
  emails: Record<string, string>
}
export const loadAtRisk = (days: number) =>
  get<{ days: number; oldEnough: number; workspaces: AtRiskWorkspace[] }>(`/v1/admin/onboarding?days=${days}`)

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
  /** Done by an AI agent with the actor's setup link (agent setup): the setup key's id. */
  viaSetupKey?: string | null
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

/** GET /v1/admin/setup-checklist (apps/api/src/setup-checklist.ts): every group's status as the server sees it. */
export const loadSetupChecklist = () => get<StatusGroups>('/v1/admin/setup-checklist')
