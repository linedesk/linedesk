// The admin area talks to the API directly. Its rows cross workspaces, so they are not in the
// local store, and its writes skip the outbox on purpose: an outbox entry is kept in IndexedDB,
// and a provider key must never be stored in the browser.
import type { ProviderCategory, ProviderName, ProviderTestData } from '@linedesk/actions'

export type AdminWorkspace = {
  id: string
  name: string
  created_at: string
  disabled_at: string | null
  members: number
  phone_numbers: string[]
  calls_30d: number
  last_call_at: string | null
  minutes_this_month: number
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
  workspaces: { id: string; name: string; role: string }[]
}

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
}
export type AdminHealth = Record<'api' | 'livekit' | 'sip' | 'agent' | 'email', ServiceStatus>
export type LivekitStatus = { url: string | null; server: ServiceStatus; sip: ServiceStatus }

export type AdminData = {
  workspaces: AdminWorkspace[]
  users: AdminUser[]
  usage: UsageRow[]
  usageMonths: number
  providers: ProviderStatus[]
  activeProviders: ActiveProviders
  canStoreKeys: boolean
}

async function body<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !json) throw new Error(json?.error ?? `The server answered ${res.status}`)
  return json
}

/** Admin requests go ahead of the read sync's when the browser queues requests. */
const HIGH = { priority: 'high' } as RequestInit
const get = async <T>(path: string) => body<T>(await fetch(path, { ...HIGH, credentials: 'include' }))

export async function loadAdminData(): Promise<AdminData> {
  const [w, u, usage, p] = await Promise.all([
    get<{ workspaces: AdminWorkspace[] }>('/v1/admin/workspaces'),
    get<{ users: AdminUser[] }>('/v1/admin/users'),
    get<{ months: number; usage: UsageRow[] }>('/v1/admin/usage'),
    get<{ can_store: boolean; active: ActiveProviders; providers: ProviderStatus[] }>('/v1/admin/providers'),
  ])
  return {
    workspaces: w.workspaces,
    users: u.users,
    usage: usage.usage,
    usageMonths: usage.months,
    providers: p.providers,
    activeProviders: p.active,
    canStoreKeys: p.can_store,
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
  'instanceAdmin.grant': { userId: string }
  'instanceAdmin.revoke': { userId: string }
}

/** Runs an admin action through the registry. Throws with the server's reason when it is rejected. */
export async function runAdmin<N extends keyof AdminInputs>(name: N, input: AdminInputs[N]) {
  const res = await fetch(`/v1/actions/${name}`, {
    ...HIGH,
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await body<{ data?: Record<string, unknown> }>(res)).data ?? {}
}

export const testProvider = async (provider: ProviderName) =>
  (await runAdmin('provider.test', { provider })) as ProviderTestData

/** LiveKit is part of the install: its status is read-only. Can take a few seconds when the server is down. */
export const loadLivekitStatus = async () => (await get<{ livekit: LivekitStatus }>('/v1/admin/system')).livekit

export const loadOverview = () => get<AdminOverview>('/v1/admin/overview')
/** Waits for LiveKit and the mail server: can take a few seconds. */
export const loadHealth = () => get<AdminHealth>('/v1/admin/health')
