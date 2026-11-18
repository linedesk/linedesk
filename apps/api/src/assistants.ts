// A workspace's assistants: which one answers a number or a test call, and the actions that add,
// copy and delete them or move a number to another one. Every lookup is scoped to the workspace, so
// an assistant id from another workspace is refused, never used.
import { assistant_calendars, assistants, organization, phone_numbers, type Tx } from '@linedesk/db'
import { recordVersion } from './assistant-versions.ts'
import { newAssistantTransfers } from './default-transfers.ts'
import { releaseUnusedClones } from './voices.ts'
import type { Assistant } from '@linedesk/db/types'
import { DEFAULT_AI_DISCLOSURE, forwardsCalls, greetingFor } from '@linedesk/actions'
import { and, asc, eq, ne } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { newAssistantLevel } from './call-quality.ts'
import { mayRaiseLevel } from './level-raise.ts'
import { picksForLevel } from './usage-levels.ts'

const newId = () => `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/**
 * Names a new assistant gets, the first one the workspace does not use yet. All female: a new
 * assistant speaks with the default voice, which is a female one, so the name has to match it.
 */
const NAMES = ['Maya', 'Ava', 'Nora', 'Ivy', 'Zoe', 'Ruby', 'Lily', 'Emma', 'Clara', 'Grace']

/** A new assistant's greeting, with the AI note of the default disclosure mode (greetingFor in @linedesk/actions). */
export { greetingFor }

/** The workspace's assistants, oldest first: the first is the default. */
export const workspaceAssistants = (tx: Tx, workspaceId: string) =>
  tx
    .select()
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .orderBy(asc(assistants.created_at), asc(assistants.id))

/**
 * The assistant with this id in this workspace, or the workspace's first when no id is given.
 * An id that is not one of the workspace's is refused.
 */
export async function assistantIn(tx: Tx, workspaceId: string, assistantId?: string | null): Promise<Assistant | null> {
  if (assistantId) {
    const [found] = await tx
      .select()
      .from(assistants)
      .where(and(eq(assistants.id, assistantId), eq(assistants.workspace_id, workspaceId)))
    if (!found) throw new Reject('assistant not found')
    return found
  }
  const [first] = await workspaceAssistants(tx, workspaceId).limit(1)
  return first ?? null
}

/** The assistant that answers a call to this number: the number's own, else the workspace's first. */
export async function assistantForNumber(
  tx: Tx,
  workspaceId: string,
  assistantId: string | null,
): Promise<Assistant | null> {
  if (assistantId) {
    const [own] = await tx
      .select()
      .from(assistants)
      .where(and(eq(assistants.id, assistantId), eq(assistants.workspace_id, workspaceId)))
    if (own) return own
  }
  return assistantIn(tx, workspaceId)
}

export const assistantHandlers: Record<string, Handler> = {
  'assistant.create': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspaceId = actor.workspaceId
    const existing = await workspaceAssistants(tx, workspaceId)
    const taken = new Set(existing.map(a => a.name))
    const name = input.name ?? NAMES.find(n => !taken.has(n)) ?? `Assistant ${existing.length + 1}`
    const [org] = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, workspaceId))
    const source = input.copyOf ? await assistantIn(tx, workspaceId, input.copyOf) : null
    // The first contact named in the workspace's language (else the member's).
    const transfers = await newAssistantTransfers(tx, workspaceId, actor.locale)
    // The install's default level, or the copied one's; a paid level only for the person who pays (level-raise.ts),
    // anyone else starts it on Standard.
    const wanted = source?.call_quality ?? (await newAssistantLevel(tx))
    const level = wanted === 'standard' || (await mayRaiseLevel(tx, actor)) ? wanted : 'standard'
    const values = source
      ? {
          ...source,
          ...(level !== source.call_quality ? { call_quality: level, ...(await picksForLevel(tx, source, level)) } : {}),
          id: newId(),
          name: input.name ?? `${source.name} copy`,
          // Transfer numbers are set on purpose per assistant (they need a confirmed email): a copy starts with the default.
          transfers,
          created_at: undefined,
          version: undefined,
        }
      : {
          id: newId(),
          workspace_id: workspaceId,
          name,
          greeting: greetingFor(org?.name ?? 'us', name),
          ai_disclosure: DEFAULT_AI_DISCLOSURE,
          transfers,
          call_quality: level,
        }
    const rows = await tx.insert(assistants).values(values).returning()
    await recordVersion(tx, workspaceId, rows[0]!.id, { by: actor.actorId, created: true })
    return { rows: { assistants: rows }, data: { assistantId: rows[0]!.id } }
  },

  'assistant.delete': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspaceId = actor.workspaceId
    const doomed = await assistantIn(tx, workspaceId, input.assistantId)
    const [next] = await tx
      .select()
      .from(assistants)
      .where(and(eq(assistants.workspace_id, workspaceId), ne(assistants.id, doomed!.id)))
      .orderBy(asc(assistants.created_at), asc(assistants.id))
      .limit(1)
    if (!next) throw new Reject('a workspace keeps at least one assistant')
    // Its numbers go on being answered, by the first remaining assistant.
    const moved = await tx
      .update(phone_numbers)
      .set({ assistant_id: next.id })
      .where(and(eq(phone_numbers.workspace_id, workspaceId), eq(phone_numbers.assistant_id, doomed!.id)))
      .returning()
    // Its calendars go with it (foreign key cascade).
    const calendars = await tx
      .select({ id: assistant_calendars.id })
      .from(assistant_calendars)
      .where(eq(assistant_calendars.assistant_id, doomed!.id))
    await tx.delete(assistants).where(and(eq(assistants.id, doomed!.id), eq(assistants.workspace_id, workspaceId)))
    // A cloned voice only it used goes too, at the provider as well.
    await releaseUnusedClones(tx, workspaceId)
    return {
      rows: { phone_numbers: moved },
      deleted: { assistants: [doomed!.id], assistant_calendars: calendars.map(c => c.id) },
      data: { movedTo: next.id },
    }
  },

  'phoneNumber.update': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspaceId = actor.workspaceId
    const assistant = input.assistantId ? await assistantIn(tx, workspaceId, input.assistantId) : null
    // A new pick-up mode (into forwarding, or between missed calls and every call) has its own codes: the number
    // counts as verified again only after a check or a forwarded call in the new mode.
    const [current] = input.mode
      ? await tx
          .select({ mode: phone_numbers.mode })
          .from(phone_numbers)
          .where(and(eq(phone_numbers.id, input.phoneNumberId), eq(phone_numbers.workspace_id, workspaceId)))
      : []
    const unverify = Boolean(current && input.mode !== current.mode && forwardsCalls(input.mode))
    const set = {
      ...(input.mode ? { mode: input.mode } : {}),
      ...(assistant ? { assistant_id: assistant.id } : {}),
      ...(unverify ? { verified_at: null } : {}),
    }
    const rows = await tx
      .update(phone_numbers)
      .set(set)
      .where(and(eq(phone_numbers.id, input.phoneNumberId), eq(phone_numbers.workspace_id, workspaceId)))
      .returning()
    if (!rows[0]) throw new Reject('phone number not found')
    return { rows: { phone_numbers: rows } }
  },
}
