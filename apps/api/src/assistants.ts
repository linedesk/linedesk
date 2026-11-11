// A workspace's assistants: which one answers a number or a test call, and the actions that add,
// copy and delete them or move a number to another one. Every lookup is scoped to the workspace, so
// an assistant id from another workspace is refused, never used.
import { assistant_calendars, assistants, organization, phone_numbers, type Tx } from '@linedesk/db'
import { releaseUnusedClones } from './voices.ts'
import type { Assistant } from '@linedesk/db/types'
import { and, asc, eq, ne } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const newId = () => `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** Names a new assistant gets, the first one the workspace does not use yet. */
const NAMES = ['Maya', 'Ava', 'Leo', 'Nora', 'Sam', 'Ivy', 'Max', 'Zoe', 'Eli', 'Ruby']

export const greetingFor = (businessName: string, name: string) =>
  `Thanks for calling ${businessName}. This is ${name}, the AI assistant. How can I help?`

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
    const values = source
      ? {
          ...source,
          id: newId(),
          name: input.name ?? `${source.name} copy`,
          created_at: undefined,
          version: undefined,
        }
      : { id: newId(), workspace_id: workspaceId, name, greeting: greetingFor(org?.name ?? 'us', name) }
    const rows = await tx.insert(assistants).values(values).returning()
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
    const calendars = await tx.select({ id: assistant_calendars.id }).from(assistant_calendars).where(eq(assistant_calendars.assistant_id, doomed!.id))
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
    const set = { ...(input.mode ? { mode: input.mode } : {}), ...(assistant ? { assistant_id: assistant.id } : {}) }
    const rows = await tx
      .update(phone_numbers)
      .set(set)
      .where(and(eq(phone_numbers.id, input.phoneNumberId), eq(phone_numbers.workspace_id, workspaceId)))
      .returning()
    if (!rows[0]) throw new Reject('phone number not found')
    return { rows: { phone_numbers: rows } }
  },
}
