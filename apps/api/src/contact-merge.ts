// contact.merge: two contacts that are one person become one. The kept contact gets the details the
// member picked, the other one's calls and bookings move to it, and the other one is deleted with
// `merged_into` set, so a later call from its number lands on the kept contact (handlers.ts, openCall).
import { bookings, calls, contacts, type Tx } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

type MergeInput = {
  keepId: string
  mergeId: string
  name?: string | null
  company?: string | null
  email?: string | null
  address?: string | null
  note?: string | null
}

async function liveContact(tx: Tx, workspaceId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspace_id, workspaceId)))
  if (!contact || contact.deleted_at) throw new Reject('contact not found')
  return contact
}

const given = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

export const contactMergeHandlers: Record<string, Handler> = {
  'contact.merge': async ({ tx, actor, now }, { keepId, mergeId, ...fields }: MergeInput) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    if (keepId === mergeId) throw new Reject('pick two different contacts')
    const keep = await liveContact(tx, actor.workspaceId, keepId)
    const merged = await liveContact(tx, actor.workspaceId, mergeId)
    const movedCalls = await tx
      .update(calls)
      .set({ contact_id: keep.id })
      .where(eq(calls.contact_id, merged.id))
      .returning()
    const movedBookings = await tx
      .update(bookings)
      .set({ contact_id: keep.id })
      .where(eq(bookings.contact_id, merged.id))
      .returning()
    // Contacts merged into the other one before now point at the kept one: one step from any old number.
    const repointed = await tx
      .update(contacts)
      .set({ merged_into: keep.id })
      .where(eq(contacts.merged_into, merged.id))
      .returning()
    const [gone] = await tx
      .update(contacts)
      .set({ deleted_at: now, merged_into: keep.id })
      .where(eq(contacts.id, merged.id))
      .returning()
    // Blocked stays blocked: a caller blocked under either number is still unwanted.
    const [kept] = await tx
      .update(contacts)
      .set({ ...given(fields), blocked_at: keep.blocked_at ?? merged.blocked_at })
      .where(eq(contacts.id, keep.id))
      .returning()
    return {
      rows: { contacts: [kept!, gone!, ...repointed], calls: movedCalls, bookings: movedBookings },
      data: { contactId: kept!.id, movedCalls: movedCalls.length },
    }
  },
}
