// What the command log (`commands`, written by run-action.ts) keeps of an action, and for how long.
// It is there for idempotent replays and the audit log, not as a second copy of callers' data:
// - results keep their rows only by id; a replay reads the rows again (`replayedResult`);
// - actions marked `logged: 'ids'` (the voice agent's per-call actions, bookings, contact imports and merges)
//   keep only the ids of their input and result data, never transcript lines, names or numbers;
// - deleting a call or a contact purges the commands about it the same way (`purgeCommandsAbout`);
// - after COMMAND_INPUT_RETENTION_DAYS every command's input and result are cut down to ids, except
//   the audited actions (team, admin, keys), whose inputs the audit log shows; a change of transfer contacts keeps
//   only its `data.transferChanges` (`pruneOldCommands`).
import { type ActionDef, type ActionResult, REDACTED, redactInput } from '@linedesk/actions'
import { commands, syncedTables, type Tx } from '@linedesk/db'
import type { TableName } from '@linedesk/db/types'
import { and, eq, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { AUDITED_ACTIONS, TRANSFER_CHANGE_ACTIONS } from './audit.ts'

export const OMITTED = '[omitted]'
/** Decision 2026-11-11: inputs and results 90 days, then ids only; when, who and what action stay. */
export const COMMAND_INPUT_RETENTION_DAYS = 90
/** Rows pruned per statement, so the job never holds a long lock on the table. */
const PRUNE_BATCH = 2000

const isIdKey = (key: string) => key === 'id' || key.endsWith('Id')
const keepsValue = (key: string, value: unknown) =>
  isIdKey(key) || typeof value === 'number' || typeof value === 'boolean'

/** Ids, numbers and booleans as they are; every other value only as `[omitted]`, so the keys still say what was sent. */
export function idsOnly(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, keepsValue(key, v) ? v : OMITTED]))
}

/** `data` with the named secret fields (an agent call token) `[redacted]`; the rest as it is. */
function withoutSecretFields(fields: readonly string[] | undefined, data: unknown) {
  if (!fields?.length || !data || typeof data !== 'object') return data
  const copy = { ...(data as Record<string, unknown>) }
  for (const field of fields) if (field in copy) copy[field] = REDACTED
  return copy
}

/** What the log keeps of a successful result: rows by id, `data` without secret or (with `logged: 'ids'`) personal fields. */
export type StoredResult = Omit<ActionResult, 'rows'> & { rowIds?: Partial<Record<TableName, string[]>> }

export function storedResult(
  def: Pick<ActionDef, 'secretResult' | 'logged' | 'sensitive'>,
  result: ActionResult,
): StoredResult {
  const { rows, data, ...rest } = result
  const rowIds = Object.fromEntries(
    Object.entries(rows).map(([table, list]) => [table, (list ?? []).map(row => String(row.id))]),
  )
  const kept =
    def.secretResult === true
      ? { redacted: REDACTED }
      : withoutSecretFields(def.secretResult, def.logged === 'ids' ? idsOnly(data) : data && redactInput(def, data))
  return { ...rest, rowIds, ...(kept ? { data: kept as Record<string, unknown> } : {}) }
}

/** The input as the log keeps it: with `logged: 'ids'` only its ids. Secrets are redacted before this (redactInput). */
export const storedInput = (def: Pick<ActionDef, 'logged'>, input: unknown) =>
  def.logged === 'ids' ? idsOnly(input) : input

/** A replayed command's result: the rows it returned, read again by id (as they are now), in the command's workspace. */
export async function replayedResult(tx: Tx, workspaceId: string | null, stored: unknown): Promise<unknown> {
  const { rowIds, ...rest } = stored as StoredResult & { rows?: unknown }
  if (!rowIds || 'rows' in rest) return stored // a rejection, or written before rows were kept by id
  const rows: Record<string, unknown[]> = {}
  for (const [table, ids] of Object.entries(rowIds) as [TableName, string[]][]) {
    const t = syncedTables[table]
    if (!t || !ids.length) continue
    // The ids come from the command's own result; a command without a workspace (call.start) names its rows' workspace in them.
    rows[table] = await tx
      .select()
      .from(t)
      .where(workspaceId ? and(inArray(t.id, ids), eq(t.workspace_id, workspaceId)) : inArray(t.id, ids))
  }
  return { ...rest, rows }
}

/** `idsOnly` in SQL, for a jsonb column or expression. */
const idsOnlySql = (value: SQL) => sql`(
  select coalesce(jsonb_object_agg(key, case when key = 'id' or key like '%Id' or jsonb_typeof(v) in ('number', 'boolean') then v else ${JSON.stringify(OMITTED)}::jsonb end), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(${value}) = 'object' then ${value} else '{}'::jsonb end) as e(key, v)
)`

/** A stored result cut down to whether it succeeded and the ids in its data (rows were never kept in full since this file). */
const prunedResultSql = sql`jsonb_strip_nulls(jsonb_build_object('ok', ${commands.result} -> 'ok', 'data', case when ${commands.result} ? 'data' then ${idsOnlySql(sql`${commands.result} -> 'data'`)} end))`

/**
 * A change of transfer contacts keeps its `data.transferChanges` (ids, names, last four digits: audit.ts), a change
 * of the usage level its `data.usageLevelChange` (model ids), and a change of the call email instruction its
 * `data.emailRoutingChanges` (who it added and removed), which the audit log shows; everything else of its result and
 * input goes down to ids like any command's.
 */
const auditedObject = (key: 'transferChanges' | 'usageLevelChange' | 'emailRoutingChanges') =>
  sql`jsonb_typeof(${commands.result} -> 'data' -> ${sql.raw(`'${key}'`)}) = 'object'`
const keptTransferChangesSql = sql`case when ${commands.action} in (${sql.join(
  TRANSFER_CHANGE_ACTIONS.map(a => sql`${a}`),
  sql`, `,
)}) and (${auditedObject('transferChanges')} or ${auditedObject('usageLevelChange')} or ${auditedObject('emailRoutingChanges')}) then jsonb_build_object('ok', ${commands.result} -> 'ok', 'data', jsonb_strip_nulls(jsonb_build_object('transferChanges', case when ${auditedObject('transferChanges')} then ${commands.result} -> 'data' -> 'transferChanges' end, 'usageLevelChange', case when ${auditedObject('usageLevelChange')} then ${commands.result} -> 'data' -> 'usageLevelChange' end, 'emailRoutingChanges', case when ${auditedObject('emailRoutingChanges')} then ${commands.result} -> 'data' -> 'emailRoutingChanges' end))) else ${prunedResultSql} end`

/** `keepTransferChanges`: the 90-day prune keeps what the audit log shows of a change of transfer contacts. */
export const pruneSet = (now: Date, { keepTransferChanges = false } = {}) => ({
  input: idsOnlySql(sql`${commands.input}`),
  result: keepTransferChanges ? keptTransferChangesSql : prunedResultSql,
  // A hash of the input is a trace of it too: it goes with the rest (security review of #1116, L-1).
  input_hash: null,
  pruned_at: now.toISOString(),
})

/** Input fields that name a contact: its own actions, and both sides of a merge. */
const CONTACT_FIELDS = ['contactId', 'keepId', 'mergeId'] as const

/** Commands whose input or result data names `id` in one of `fields`. Containment (`@>`), so the GIN indexes apply. */
function commandsNaming(fields: readonly string[], id: string) {
  return or(
    ...fields.flatMap(field => [
      sql`${commands.input} @> ${JSON.stringify({ [field]: id })}::jsonb`,
      sql`${commands.result} @> ${JSON.stringify({ data: { [field]: id } })}::jsonb`,
    ]),
  )
}

/**
 * A call or a contact was deleted: the commands about it keep only ids from now on (transcript lines,
 * messages, summaries, caller names, numbers and addresses go). A contact is also named by a merge
 * (`keepId`, `mergeId`; older merges stored the merged details in clear). In the same transaction as the delete.
 */
export async function purgeCommandsAbout(
  tx: Tx,
  workspaceId: string,
  field: 'callId' | 'contactId',
  id: string,
  now = new Date(),
) {
  const fields = field === 'contactId' ? CONTACT_FIELDS : [field]
  await tx
    .update(commands)
    .set(pruneSet(now))
    .where(and(eq(commands.workspace_id, workspaceId), isNull(commands.pruned_at), commandsNaming(fields, id)))
}

/** The daily job: commands older than the retention keep only ids, except the audited actions. Returns how many were pruned. */
export async function pruneOldCommands(tx: Tx, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - COMMAND_INPUT_RETENTION_DAYS * 86_400_000).toISOString()
  let total = 0
  for (;;) {
    const batch = tx
      .select({ id: commands.id })
      .from(commands)
      .where(
        and(
          isNull(commands.pruned_at),
          lt(commands.created_at, before),
          notInArray(commands.action, Object.keys(AUDITED_ACTIONS)),
        ),
      )
      .limit(PRUNE_BATCH)
    const pruned = await tx
      .update(commands)
      .set(pruneSet(now, { keepTransferChanges: true }))
      .where(inArray(commands.id, batch))
      .returning({ id: commands.id })
    total += pruned.length
    if (pruned.length < PRUNE_BATCH) return total
  }
}
