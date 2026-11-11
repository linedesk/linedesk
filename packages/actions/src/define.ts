// One definition per action. `patch` is the declarative part shared by both sides: the browser
// applies it to its local rows at once (optimistic), the API runs the same patch as an UPDATE
// scoped to the caller's workspace. Actions without `patch` get a server handler in apps/api.
import type { TableName, Tables } from '@linedesk/db/types'
import type { z } from 'zod'

/**
 * `instance:admin` belongs to no role: the API adds it for users who operate the install, in any workspace.
 * `impersonation:stop` belongs to no role either: the API adds it only to a session an instance admin started as another user.
 */
export type Permission = 'call:read' | 'call:write' | 'contact:write' | 'settings:write' | 'calendar:read' | 'team:read' | 'team:write' | 'agent' | 'instance:admin' | 'impersonation:stop'
export type Role = 'owner' | 'admin' | 'member' | 'agent'

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: ['call:read', 'call:write', 'contact:write', 'settings:write', 'calendar:read', 'team:read', 'team:write'],
  admin: ['call:read', 'call:write', 'contact:write', 'settings:write', 'calendar:read', 'team:read', 'team:write'],
  member: ['call:read', 'call:write', 'contact:write', 'calendar:read', 'team:read'],
  agent: ['call:write', 'contact:write', 'calendar:read', 'agent'],
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
  /** Top-level input fields that hold secrets. The API replaces their values before it stores or logs the input. */
  sensitive?: readonly string[]
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
