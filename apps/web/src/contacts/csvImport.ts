// Contacts from a CSV file: parse it, guess which column is what, and plan the import (what is new,
// what matches an existing contact by number or email, what cannot be read). Pure, so it is tested
// without a browser; the dialog (ImportContacts.tsx) shows the plan and sends it with contact.import.
import type { Contact } from '@linedesk/db/types'
import { toE164 } from '../onboarding/flow.ts'

export const IMPORT_FIELDS = ['phone', 'name', 'company', 'email', 'address', 'note'] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
/** Per column of the file: the contact field it fills, or `skip`. */
export type ColumnMap = (ImportField | 'skip')[]
export type ImportRow = { phone: string } & Partial<Record<Exclude<ImportField, 'phone'>, string>>

/** RFC 4180: commas (or semicolons, as some spreadsheets export), quotes doubled inside quoted fields, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '')
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

const HEADER_WORDS: Record<ImportField, RegExp> = {
  phone: /phone|mobile|cell|tel|number|nummer/i,
  email: /e-?mail/i,
  company: /company|business|organi[sz]ation|firma/i,
  address: /address|street|adresse/i,
  note: /note|comment|notiz/i,
  name: /name/i,
}

/** Which field each column is, from its header; a field goes to its first matching column only. */
export function guessColumns(header: string[]): ColumnMap {
  const taken = new Set<ImportField>()
  return header.map(title => {
    // Phone before name ("Phone number"), email before name ("Email name"): IMPORT_FIELDS order is not the check order.
    const field = (['phone', 'email', 'company', 'address', 'note', 'name'] as const).find(
      f => !taken.has(f) && HEADER_WORDS[f].test(title),
    )
    if (!field) return 'skip'
    taken.add(field)
    return field
  })
}

export type ImportPlan = {
  /** What contact.import gets: one row per number, later rows of the same number merged into the first. */
  rows: ImportRow[]
  /** Rows that become new contacts, and rows that match an existing one (filling its empty fields). */
  added: number
  matched: number
  /** Rows without a number that can be read (row numbers in the file, 1 = first data row). */
  unreadable: number[]
  /** Rows whose number already came earlier in the file. */
  repeated: number
}

const emailKey = (email: string | null | undefined) => email?.trim().toLowerCase() || null

/** A number from a file in E.164: US numbers as people write them, others when they start with + and a country code. */
export function importPhone(text: string): string | null {
  const digits = text.replace(/\D/g, '')
  if (text.trim().startsWith('+') && !text.trim().startsWith('+1') && digits.length >= 8 && digits.length <= 15)
    return `+${digits}`
  return toE164(text)
}

/** The rows of the file (without the header) as contacts to import, checked against the existing ones. */
export function planImport(data: string[][], columns: ColumnMap, existing: Iterable<Contact>): ImportPlan {
  const phones = new Set<string>()
  const emails = new Set<string>()
  for (const c of existing) {
    if (c.deleted_at) continue
    phones.add(c.phone)
    if (emailKey(c.email)) emails.add(emailKey(c.email)!)
  }
  const byPhone = new Map<string, ImportRow>()
  const plan: ImportPlan = { rows: [], added: 0, matched: 0, unreadable: [], repeated: 0 }
  data.forEach((cells, i) => {
    const row: Partial<Record<ImportField, string>> = {}
    columns.forEach((field, col) => {
      const text = cells[col]?.trim()
      if (field !== 'skip' && text && !row[field]) row[field] = text
    })
    const phone = row.phone ? importPhone(row.phone) : null
    if (!phone) return void plan.unreadable.push(i + 1)
    const earlier = byPhone.get(phone)
    if (earlier) {
      plan.repeated++
      for (const f of IMPORT_FIELDS) if (f !== 'phone' && !earlier[f] && row[f]) earlier[f] = row[f]
      return
    }
    const entry: ImportRow = { ...row, phone }
    byPhone.set(phone, entry)
    plan.rows.push(entry)
    if (phones.has(phone) || (emailKey(entry.email) && emails.has(emailKey(entry.email)!))) plan.matched++
    else plan.added++
  })
  return plan
}
