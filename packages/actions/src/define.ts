// One definition per action. `patch` is the declarative part shared by both sides: the browser
// applies it to its local rows at once (optimistic), the API runs the same patch as an UPDATE
// scoped to the caller's workspace. Actions without `patch` get a server handler in apps/api; an
// action with both is applied optimistically and its handler runs on the server (to check more).
import type { TableName, Tables } from '@linedesk/db/types'
import type { z } from 'zod'

/**
 * `instance:admin` belongs to no role: the API adds it for users who operate the install, in any workspace.
 * `impersonation:stop` belongs to no role either: the API adds it only to a session an instance admin started as another user.
 * `setupLink:end` belongs to no role either: the API adds it to every session of an instance admin (not while
 * impersonating), also before the passkey check, so ending their own agent setup links is never harder than making one.
 * `secondFactor:own` likewise (every session of an instance admin, not while impersonating): their own authenticator
 * app, the alternative to the passkey for Server admin (authenticator.ts). Its handlers check the rest.
 */
/**
 * `account:own`: a person's own account, here their personal API keys (personal-keys.ts). It belongs to no role: the API
 * adds it to every session of a person signed in as themselves (not while impersonating), with or without a workspace,
 * and never to a key, so a key never makes or revokes keys.
 */
/** `call:export`: every call of a date range at once (call.export), owners and admins only. */
/**
 * `call:erase`: a deleted call erased at once instead of after 30 days (call.delete with `permanent`), owners and admins
 * only: it cannot be undone. Not an action's permission; the call.delete handler checks it.
 */
/**
 * `billing:manage`: what changes what the workspace pays (the plan, payment method, recharges and the cap, Allow
 * Premium and Allow Ultra; docs/billing.md §8). Owners and admins hold it (decision of 2026-11-17); the handlers let
 * through only who manages the bill: its owner, or an owner or admin of the only workspace it pays for (managesBill in
 * apps/api), never on a partner bill or a bill of several workspaces they do not own. Never an API key, a setup link or
 * an impersonation (the handlers refuse those too: refuseBillingActor in apps/api).
 */
/**
 * `billing:system`: the Stripe webhook's processor and the billing jobs (docs/billing.md §5.1, §8). No role, no API key,
 * no setup link and no session has it; only the API's own billing jobs act with it (apps/api/src/stripe-events.ts).
 */
/**
 * `account`: what a signed-in person does for their own account, with or without a workspace: self-serve sign-up
 * (`account.signUp`, docs/billing.md §3.1). No role has it; the API gives it only on the sign-up route, to a person
 * signed in as themselves (never an API key, a setup link, the agent or an impersonation).
 */
/**
 * `partner`: a member of a white-label partner's team (docs/white-label.md). It belongs to no role: the API adds it to a
 * session of a person on any partner team (context.ts), never to a key, a setup link or the agent. Which partner and
 * which partner role is checked by every partner handler against `partner_members` (apps/api/src/partners.ts), so a
 * member of one partner reaches nothing of another.
 */
/**
 * `workspace:own`: what only the workspace's one owner does: delete the workspace and hand it over to someone else
 * (workspace rights, docs/architecture.md). Never part of an API key's permissions (api-keys.ts).
 */
export type Permission =
  | 'call:read'
  | 'call:write'
  | 'call:export'
  | 'call:erase'
  | 'contact:write'
  | 'settings:write'
  | 'calendar:read'
  | 'calendar:write'
  | 'team:read'
  | 'team:write'
  | 'workspace:own'
  | 'billing:manage'
  | 'billing:system'
  | 'agent'
  | 'instance:admin'
  | 'impersonation:stop'
  | 'setupLink:end'
  | 'secondFactor:own'
  | 'invitation:respond'
  | 'account:own'
  | 'account:signUp'
  | 'partner'
export type Role = 'owner' | 'admin' | 'member' | 'agent'

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: [
    'call:read',
    'call:write',
    'call:export',
    'call:erase',
    'contact:write',
    'settings:write',
    'calendar:read',
    'calendar:write',
    'team:read',
    'team:write',
    'workspace:own',
    'billing:manage',
    'invitation:respond',
  ],
  admin: [
    'call:read',
    'call:write',
    'call:export',
    'call:erase',
    'contact:write',
    'settings:write',
    'calendar:read',
    'calendar:write',
    'team:read',
    'team:write',
    'billing:manage',
    'invitation:respond',
  ],
  member: [
    'call:read',
    'call:write',
    'contact:write',
    'calendar:read',
    'calendar:write',
    'team:read',
    'invitation:respond',
  ],
  // The voice agent: only the `agent` actions, plus the member actions marked with `agent` below.
  agent: ['agent'],
}

export interface PatchSpec<I, T extends TableName = TableName> {
  table: T
  id: (input: I) => string
  /** `now` is an ISO timestamp, so both sides write the same value. */
  set: (input: I, now: string) => Partial<Tables[T]>
}

export interface ActionDef<S extends z.ZodType = z.ZodType, T extends TableName = TableName> {
  name: string
  description: string
  input: S
  permission: Permission
  patch?: PatchSpec<z.infer<S>, T>
  /** The action changes nothing: the API neither logs it as a command nor makes it idempotent. */
  readOnly?: true
  /** Part of the public API: listed in GET /v1/openapi.json, the only actions an API key runs, and offered as an MCP tool. */
  public?: true
  /**
   * Deletes, cancels, moves, blocks or files as spam something people rely on. MCP marks the tool `destructiveHint`
   * and offers it only to admin keys: an assistant reading caller text must not be steered into it.
   */
  destructive?: true
  /**
   * Top-level fields that hold secrets, in the input and in the result's `data` (an invitation id opens
   * the invitation). The API replaces their values before it stores or logs either.
   */
  sensitive?: readonly string[]
  /**
   * Top-level URL fields of which the command log keeps only the host (a webhook URL's path or query can carry the
   * receiver's token, and audited commands are kept for good). The action itself gets the full URL.
   */
  loggedHostOnly?: readonly string[]
  /**
   * `ids`: the command log keeps only the ids of the input and of the result's data, never the rest
   * (transcript lines, messages, caller names, numbers and addresses): the voice agent's per-call
   * actions, bookings, contact imports and merges. apps/api/src/command-log.ts.
   */
  logged?: 'ids'
  /**
   * The result's `data` holds a secret shown once (a new API key): the command log keeps the result without it.
   * A list names only the `data` fields that are secret (an agent call token); the rest is kept.
   */
  secretResult?: true | readonly string[]
  /**
   * A member action the voice agent may also run (its role has only `agent`): `call` only for the
   * call named by the input's `callId`, `workspace` within the call's workspace.
   */
  agent?: 'call' | 'workspace'
}

export const defineAction = <S extends z.ZodType, T extends TableName>(def: ActionDef<S, T>) => def

export const REDACTED = '[redacted]'

/** The input as it may be stored and logged: sensitive fields keep their keys, never their values. */
export function redactInput(def: Pick<ActionDef, 'sensitive'>, input: unknown): unknown {
  if (!def.sensitive?.length || typeof input !== 'object' || input === null) return input
  const redacted: Record<string, unknown> = { ...input }
  for (const field of def.sensitive) {
    const value = redacted[field]
    if (value === undefined) continue
    const isRecord = typeof value === 'object' && value !== null && !Array.isArray(value)
    redacted[field] = isRecord ? Object.fromEntries(Object.keys(value).map(key => [key, REDACTED])) : REDACTED
  }
  return redacted
}

/** Rows per table, keyed by id: the shape of the browser's local store. */
export type LocalTables = { [T in TableName]: Map<string, Tables[T]> }

/** Optimistic apply in the browser. No-op for actions without a patch or unknown rows. */
export function applyLocally(tables: LocalTables, def: ActionDef, input: unknown, now: string) {
  if (!def.patch) return
  const rows = tables[def.patch.table] as Map<string, Record<string, unknown>>
  const id = def.patch.id(input)
  const row = rows.get(id)
  if (row) rows.set(id, { ...row, ...def.patch.set(input, now) })
}
