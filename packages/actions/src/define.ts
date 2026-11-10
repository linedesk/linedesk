// One definition per action. `patch` is the declarative part shared by both sides: the browser
// applies it to its local rows at once (optimistic), the API runs the same patch as an UPDATE
// scoped to the caller's workspace. Actions without `patch` get a server handler in apps/api.
import type { TableName, Tables } from '@callfront/db/types'
import type { z } from 'zod'

export type Permission = 'call:read' | 'call:write' | 'contact:write' | 'settings:write' | 'calendar:read' | 'agent'
export type Role = 'owner' | 'admin' | 'member' | 'agent'

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: ['call:read', 'call:write', 'contact:write', 'settings:write', 'calendar:read'],
  admin: ['call:read', 'call:write', 'contact:write', 'settings:write', 'calendar:read'],
  member: ['call:read', 'call:write', 'contact:write', 'calendar:read'],
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
}

export const defineAction = <S extends z.ZodType, T extends TableName>(def: ActionDef<S, T>) => def

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
