// Versions of an assistant's call settings (docs/architecture.md, Assistant versions). Every write that
// changes them ends with recordVersion in the same transaction; calls look up the version they run with.
import {
  type AssistantSnapshot,
  type AssistantVersionData,
  type AssistantVersionItem,
  type AssistantVersionsData,
  snapshotOf,
  stableJson,
  storedSnapshot,
  versionSummary,
} from '@linedesk/actions'
import { assistant_calendars, assistant_versions, assistants, user, type Tx } from '@linedesk/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { type Handler, type HandlerCtx, Reject } from './handler-context.ts'

const newId = () => `asv_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** Versions the History panel lists; older ones stay stored (calls name them) but are not listed. */
const LISTED_VERSIONS = 100

async function currentSnapshot(tx: Tx, workspaceId: string, assistantId: string): Promise<AssistantSnapshot | null> {
  const [assistant] = await tx
    .select()
    .from(assistants)
    .where(and(eq(assistants.id, assistantId), eq(assistants.workspace_id, workspaceId)))
  if (!assistant) return null
  const calendars = await tx.select().from(assistant_calendars).where(eq(assistant_calendars.assistant_id, assistantId))
  return snapshotOf(assistant, calendars)
}

const latestVersion = (tx: Tx, assistantId: string) =>
  tx
    .select({ number: assistant_versions.number, settings: assistant_versions.settings })
    .from(assistant_versions)
    .where(eq(assistant_versions.assistant_id, assistantId))
    .orderBy(desc(assistant_versions.number))
    .limit(1)
    .then(rows => rows[0] ?? null)

/** `by`: the user who changed it (null: Linedesk); `created`: the assistant's first settings. */
type Recorded = { by: string | null; restoredFrom?: number; created?: boolean }

/**
 * Stores the assistant's settings as a new version when they differ from the newest one, and returns the
 * number calls use now. Serialised per assistant, so two saves never take the same number.
 */
export async function recordVersion(
  tx: Tx,
  workspaceId: string,
  assistantId: string,
  { by, restoredFrom, created }: Recorded,
): Promise<number | null> {
  await lockAssistantVersion(tx, assistantId)
  const now = await currentSnapshot(tx, workspaceId, assistantId)
  if (!now) return null
  const latest = await latestVersion(tx, assistantId)
  const before = latest ? storedSnapshot(latest.settings) : undefined
  if (before && stableJson(before) === stableJson(now) && !restoredFrom) return latest!.number
  const number = (latest?.number ?? 0) + 1
  await tx.insert(assistant_versions).values({
    id: newId(),
    workspace_id: workspaceId,
    assistant_id: assistantId,
    number,
    settings: now,
    summary: created ? 'Created' : versionSummary(before ?? null, now, restoredFrom),
    changed_by: by,
    restored_from: restoredFrom ?? null,
  })
  return number
}

/**
 * The lock every change of an assistant's settings takes first (withVersion, restoreVersion, recordVersion), before
 * the workspace settings and the assistant row: one order everywhere, so two changes wait for each other instead of
 * deadlocking. Held until the transaction ends; taking it again in the same transaction does not wait.
 */
export const lockAssistantVersion = (tx: Tx, assistantId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant-version:${assistantId}`}))`)

/**
 * The version lock of every assistant of the workspace, in the order of their ids: for a change of the workspace that
 * then changes its assistants (a level turned off, a payer change), taken before anything else, as a single save takes its own.
 */
export async function lockAssistantVersionsOf(tx: Tx, workspaceId: string) {
  const ids = await tx
    .select({ id: assistants.id })
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .orderBy(asc(assistants.id))
  for (const { id } of ids) await lockAssistantVersion(tx, id)
}

/** Before a change: the settings as they are now are a version, so the change can be undone. */
export const keepCurrentVersion = (tx: Tx, workspaceId: string, assistantId: string) =>
  recordVersion(tx, workspaceId, assistantId, { by: null })

/**
 * The version a call starts with. Normally the newest, read without a lock; a change that skipped
 * recordVersion (an older release during an update) becomes a version of its own first.
 */
export async function versionForCall(
  tx: Tx,
  workspaceId: string,
  assistantId: string | null | undefined,
): Promise<number | null> {
  if (!assistantId) return null
  const [latest, now] = await Promise.all([
    latestVersion(tx, assistantId),
    currentSnapshot(tx, workspaceId, assistantId),
  ])
  if (latest && now && stableJson(latest.settings) === stableJson(now)) return latest.number
  // A savepoint (or a transaction of its own for a read-only action), so the lock holds until the version is in.
  return tx.transaction(t => recordVersion(t, workspaceId, assistantId, { by: null }))
}

const workspaceOf = (workspaceId: string | null) => {
  if (!workspaceId) throw new Reject('no workspace')
  return workspaceId
}

async function ownAssistant(tx: Tx, workspaceId: string, assistantId: string) {
  const [found] = await tx
    .select({ id: assistants.id })
    .from(assistants)
    .where(and(eq(assistants.id, assistantId), eq(assistants.workspace_id, workspaceId)))
  if (!found) throw new Reject('assistant not found')
}

const itemColumns = {
  number: assistant_versions.number,
  summary: assistant_versions.summary,
  created_at: assistant_versions.created_at,
  by: sql<string | null>`coalesce(nullif(${user.name}, ''), ${user.email})`,
  restored_from: assistant_versions.restored_from,
}

/** A version of the assistant, with its settings; refused when there is none with that number. */
export async function versionOf(tx: Tx, workspaceId: string, assistantId: string, number: number) {
  const [found] = await tx
    .select({ ...itemColumns, settings: assistant_versions.settings })
    .from(assistant_versions)
    .leftJoin(user, eq(user.id, assistant_versions.changed_by))
    .where(
      and(
        eq(assistant_versions.assistant_id, assistantId),
        eq(assistant_versions.workspace_id, workspaceId),
        eq(assistant_versions.number, number),
      ),
    )
  if (!found) throw new Reject(`version ${number} not found`)
  return { ...found, settings: storedSnapshot(found.settings) }
}

export const assistantVersionHandlers: Record<string, Handler> = {
  // The list starts with the current settings: an assistant from before versions gets its first one here.
  'assistant.versions': async ({ tx, actor }, input: { assistantId: string }) => {
    const workspaceId = workspaceOf(actor.workspaceId)
    await ownAssistant(tx, workspaceId, input.assistantId)
    const current = await versionForCall(tx, workspaceId, input.assistantId)
    const versions: AssistantVersionItem[] = await tx
      .select(itemColumns)
      .from(assistant_versions)
      .leftJoin(user, eq(user.id, assistant_versions.changed_by))
      .where(
        and(eq(assistant_versions.assistant_id, input.assistantId), eq(assistant_versions.workspace_id, workspaceId)),
      )
      .orderBy(desc(assistant_versions.number))
      .limit(LISTED_VERSIONS)
    const data: AssistantVersionsData = { versions, current }
    return { rows: {}, data }
  },

  'assistant.version': async ({ tx, actor }, input: { assistantId: string; number: number }) => {
    const workspaceId = workspaceOf(actor.workspaceId)
    const data: AssistantVersionData = { version: await versionOf(tx, workspaceId, input.assistantId, input.number) }
    return { rows: {}, data }
  },
}

/** Actions that change an assistant's call settings: each ends with a new version when something changed. */
export const VERSIONED_ACTIONS: ReadonlySet<string> = new Set([
  'assistant.update',
  'assistantCalendar.add',
  'assistantCalendar.update',
  'assistantCalendar.setDefault',
  'assistantCalendar.remove',
])

async function assistantOfCalendar(tx: Tx, workspaceId: string, assistantCalendarId: string): Promise<string | null> {
  const [row] = await tx
    .select({ assistantId: assistant_calendars.assistant_id })
    .from(assistant_calendars)
    .where(and(eq(assistant_calendars.id, assistantCalendarId), eq(assistant_calendars.workspace_id, workspaceId)))
  return row?.assistantId ?? null
}

/** Runs a versioned action: the settings before it are kept as a version, the result becomes the next one. */
export async function withVersion<R>(
  { tx, actor }: HandlerCtx,
  input: { assistantId?: string; assistantCalendarId?: string },
  run: () => Promise<R>,
): Promise<R> {
  const workspaceId = actor.workspaceId
  const assistantId = !workspaceId
    ? null
    : (input.assistantId ??
      (input.assistantCalendarId ? await assistantOfCalendar(tx, workspaceId, input.assistantCalendarId) : null))
  if (!workspaceId || !assistantId) return run()
  await keepCurrentVersion(tx, workspaceId, assistantId)
  const result = await run()
  await recordVersion(tx, workspaceId, assistantId, { by: actor.actorId })
  return result
}
