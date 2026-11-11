// contact.import: rows from a file become contacts. Matching is by number, then by email (case
// ignored): a match only gets its empty fields filled, so an import never overwrites what someone
// typed. Email matches only contacts that were there before the import: two rows of one file with the
// same email and different numbers are two contacts (the preview counts them so, and no number is lost;
// Contacts suggests merging them). A number that was merged into another contact (contact.merge) fills that one; a number of a
// contact someone deleted is skipped (removed on purpose).
import type { ContactImportData } from '@linedesk/actions'
import { contacts } from '@linedesk/db'
import type { Contact } from '@linedesk/db/types'
import { eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

type ImportRow = { phone: string; name?: string; company?: string; email?: string; address?: string; note?: string }
const FIELDS = ['name', 'company', 'email', 'address', 'note'] as const

const newId = () => `ct_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const emailKey = (email: string | null | undefined) => email?.trim().toLowerCase() || null
const value = (text: string | undefined) => text?.trim() || null

/** The row's values for the fields the contact has empty; nothing when it has them all. */
function fillEmpty(contact: Contact, row: ImportRow) {
  const fill: Partial<Record<(typeof FIELDS)[number], string>> = {}
  for (const field of FIELDS) if (!contact[field] && value(row[field])) fill[field] = value(row[field])!
  return fill
}

export const contactImportHandlers: Record<string, Handler> = {
  'contact.import': async ({ tx, actor }, input: { rows: ImportRow[] }) => {
    const workspace_id = actor.workspaceId
    if (!workspace_id) throw new Reject('no workspace')
    const all = await tx.select().from(contacts).where(eq(contacts.workspace_id, workspace_id))
    const byId = new Map(all.map(c => [c.id, c]))
    const byPhone = new Map(all.map(c => [c.phone, c]))
    const byEmail = new Map(all.filter(c => !c.deleted_at && emailKey(c.email)).map(c => [emailKey(c.email)!, c]))
    const counts: ContactImportData = { created: 0, updated: 0, unchanged: 0, skipped: 0 }
    const written = new Map<string, Contact>()
    for (const row of input.rows) {
      const numbered = byPhone.get(row.phone)
      const samePhone = numbered?.merged_into ? byId.get(numbered.merged_into) : numbered
      if (samePhone?.deleted_at) {
        counts.skipped++
        continue
      }
      const match = samePhone ?? (emailKey(row.email) ? byEmail.get(emailKey(row.email)!) : undefined)
      if (match) {
        const fill = fillEmpty(match, row)
        if (!Object.keys(fill).length) {
          counts.unchanged++
          continue
        }
        const [updated] = await tx.update(contacts).set(fill).where(eq(contacts.id, match.id)).returning()
        counts.updated++
        remember(updated!)
        continue
      }
      const fields = Object.fromEntries(FIELDS.map(f => [f, value(row[f])]))
      const [created] = await tx
        .insert(contacts)
        .values({ id: newId(), workspace_id, phone: row.phone, ...fields })
        .returning()
      counts.created++
      remember(created!)
    }
    // Later rows of the same file see what earlier ones wrote (one person twice in a file is one contact).
    function remember(contact: Contact) {
      written.set(contact.id, contact)
      byId.set(contact.id, contact)
      byPhone.set(contact.phone, contact)
    }
    return { rows: { contacts: [...written.values()] }, data: counts }
  },
}
