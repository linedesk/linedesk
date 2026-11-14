// Contacts from a CSV file: read its bytes, parse it, guess which column is what, and plan the import
// (what is new, what matches an existing contact by number or email, what cannot be read). Pure, so it
// is tested without a browser; the dialog (ImportContacts.tsx) shows the plan and sends it with contact.import.
import { CONTACT_IMPORT_LIMITS } from '@linedesk/actions'
import type { Contact } from '@linedesk/db/types'
import type { Table } from '../insights/spreadsheet.ts'
import { formatNumber, toE164 } from '../onboarding/flow.ts'

export const IMPORT_FIELDS = ['phone', 'name', 'company', 'email', 'address', 'note'] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
/** Per column of the file: the contact field it fills, or `skip`. */
export type ColumnMap = (ImportField | 'skip')[]
export type ImportRow = { phone: string } & Partial<Record<Exclude<ImportField, 'phone'>, string>>
type TextField = Exclude<ImportField, 'phone'>

/**
 * The example file the dialog offers to download: one column per field, named as guessColumns maps it
 * (a test imports it), fictional US contacts; an empty cell and a value with commas show how those look.
 */
export const EXAMPLE_FILE_NAME = 'linedesk-contacts-example.csv'
export const EXAMPLE_CONTACTS: Table = {
  header: ['Name', 'Phone', 'Company', 'Email', 'Address', 'Note'],
  rows: [
    ['Sam Patel', '+1 503 555 0111', 'Patel Dental', 'sam@example.com', '1200 SW Main St, Portland, OR 97205', ''],
    ['Dana Brooks', '+1 503 555 0122', '', 'dana.brooks@example.com', '', 'Prefers a text message'],
    [
      'Luis Ortega',
      '+1 503 555 0133',
      'Ortega Builders',
      '',
      '845 NE Alberta St, Portland, OR 97211',
      'Gate code 4512, ring twice',
    ],
    ['Grace Kim', '+1 503 555 0144', '', 'grace.kim@example.com', '', ''],
  ],
}

/** Fields several columns can fill: the first readable number wins; name parts and address parts are joined. */
export const MULTI_COLUMN_FIELDS: readonly (ImportField | 'skip')[] = ['phone', 'name', 'address']
const JOIN: Partial<Record<TextField, string>> = { name: ' ', address: ', ' }

export const MAX_FILE_BYTES = 10 * 1024 * 1024
const EXCEL_FILE =
  'This is an Excel workbook, not a CSV file. In Excel, choose File › Save As and pick “CSV UTF-8”, then import that file.'
const NOT_CSV = 'This file is not a CSV file. Export your contacts as CSV (comma or semicolon separated) and try again.'

/** Why a file of this size is not read, or null. */
export function fileSizeProblem(bytes: number): string | null {
  if (bytes === 0) return 'The file is empty.'
  if (bytes <= MAX_FILE_BYTES) return null
  const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`
  return `The file is ${mb(bytes)}; files up to ${mb(MAX_FILE_BYTES)} can be imported. Split it into smaller files.`
}

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b)

/** Excel saves UTF-8 (with a BOM), UTF-16 ("Unicode text") or Windows-1252 (plain "CSV" on Windows). */
function decode(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes)
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** The file's text, or why it cannot be imported (empty, too large, a workbook or not text at all). */
export function decodeCsvFile(bytes: Uint8Array): { text: string } | { problem: string } {
  const sizeProblem = fileSizeProblem(bytes.length)
  if (sizeProblem) return { problem: sizeProblem }
  // .xlsx is a zip file; .xls an OLE2 compound file.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]))
    return { problem: EXCEL_FILE }
  const text = decode(bytes)
  // Control characters other than tab and line breaks only appear in binary files (images, PDFs, archives).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is what it looks for
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text.slice(0, 8192))) return { problem: NOT_CSV }
  return { text }
}

/** Comma, semicolon (spreadsheets in many countries) or tab, whichever the first lines use most. */
function separatorOf(text: string): string {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter(l => l.trim())
    .slice(0, 5)
    .join('\n')
  const count = (sep: string) => lines.split(sep).length - 1
  return ['\t', ';'].reduce((best, sep) => (count(sep) > count(best) ? sep : best), ',')
}

/**
 * RFC 4180: quotes doubled inside quoted fields, CRLF, LF or CR. Blank lines stay in as rows of one
 * empty cell, so a row's index + 1 is its row number in a spreadsheet.
 */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '')
  const sep = separatorOf(body)
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
  return rows
}

const hasText = (cells: string[]) => cells.some(c => c.trim() !== '')

export type CsvTable = {
  header: string[]
  data: string[][] /** Spreadsheet row number of data[0]. */
  firstRow: number
}

/** The header is the first row that names a phone column (some exports put a title line above it), else the first row. */
export function tableOf(rows: string[][]): CsvTable | { problem: string } {
  const candidates = rows
    .map((cells, index) => ({ cells, index }))
    .filter(r => hasText(r.cells))
    .slice(0, 10)
  if (!candidates.length) return { problem: 'The file is empty.' }
  const header = candidates.find(r => guessColumns(r.cells).includes('phone')) ?? candidates[0]!
  const data = rows.slice(header.index + 1)
  if (!data.some(hasText))
    return { problem: 'The file has no rows under its column names. The first row names the columns.' }
  return { header: header.cells.map(h => h.trim()), data, firstRow: header.index + 2 }
}

const HEADER_WORDS: Record<ImportField, RegExp> = {
  phone: /phone|\btel|mobil|handy|cell|festnetz|^(number|nummer|nr\.?)$/i,
  email: /e-?mail|^mail$/i,
  address: /address|street|adresse|stra(ß|ss)e|anschrift|city|\bort\b|wohnort|stadt|zip|postal|plz|postleitzahl/i,
  company: /company|business|organi[sz]ation|firm|unternehmen/i,
  note: /note|comment|notiz|bemerkung|kommentar/i,
  name: /name/i,
}
/** Checked in this order: "Phone number" is a phone, "Email name" an email, "Business address" an address. */
const GUESS_ORDER = ['phone', 'email', 'address', 'company', 'note', 'name'] as const
const NOT_A_FIELD = /fax|phonetic|yomi|prefix|suffix|nick|file as|user ?name/i
/** First, middle and last name columns are joined; a full-name column is used alone. */
const NAME_PART = /first|given|vor|middle|additional|last|family|sur|nach/i

/** Which field each column is, from its header. Phone and address may be several columns, name too when it is split in parts. */
export function guessColumns(header: string[]): ColumnMap {
  const taken = new Set<ImportField>()
  const columns: ColumnMap = header.map(title => {
    // A column's kind comes from its header alone: a second email column ("E-mail 2 Address") is skipped, not an address.
    const field = NOT_A_FIELD.test(title) ? undefined : GUESS_ORDER.find(f => HEADER_WORDS[f].test(title))
    if (!field || taken.has(field)) return 'skip'
    if (!MULTI_COLUMN_FIELDS.includes(field)) taken.add(field)
    return field
  })
  const nameColumns = columns.flatMap((f, i) => (f === 'name' ? [i] : []))
  const fullName = nameColumns.find(i => !NAME_PART.test(header[i]!))
  if (fullName === undefined) return columns
  return columns.map((f, i) => (f === 'name' && i !== fullName ? 'skip' : f))
}

export type ImportPlan = {
  /** What contact.import gets: one row per number, later rows of the same number merged into the first. */
  rows: ImportRow[]
  /** Rows that become new contacts, and rows that match an existing one (filling its empty fields). */
  added: number
  matched: number
  /** Rows without a number that can be read: their spreadsheet row number and what the phone columns said. */
  unreadable: { row: number; text: string }[]
  /** Rows whose number already came earlier in the file. */
  repeated: number
  /** Rows whose number belongs to a contact someone deleted; contact.import leaves those out. */
  deleted: number
  /** Rows with a value longer than a contact keeps; it is cut to fit. */
  shortened: number
}

const emailKey = (email: string | null | undefined) => email?.trim().toLowerCase() || null

const EXTENSION = /\s*(?:;?ext=|ext\.?|extension|x|#|durchwahl|dw\.?)\s*(\d{1,6})\s*$/i

/** "503-555-0142 ext. 12" → the number and "12". */
export function splitExtension(text: string): { number: string; extension: string | null } {
  const m = EXTENSION.exec(text)
  return m ? { number: text.slice(0, m.index), extension: m[1]! } : { number: text, extension: null }
}

/** One number in E.164: US numbers as people write them, others with + or 00 and the country code. */
function onePhone(text: string): string | null {
  let compact = splitExtension(text)
    .number.replace(/\(0\)/g, '')
    .replace(/[^\d+]/g, '')
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`
  if (compact.startsWith('+') && !compact.startsWith('+1')) return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null
  return toE164(compact)
}

/** Every number in a cell ("503-555-0142 / 503-555-0199" has two), in E.164. */
export function importPhones(text: string): string[] {
  return text
    .split(/\s*(?:\/|,|;|\bor\b|\boder\b)\s*/i)
    .map(onePhone)
    .filter((p): p is string => p !== null)
}

/** The first number in a cell, in E.164, or null. */
export const importPhone = (text: string): string | null => importPhones(text)[0] ?? null

/** One row of the file as contact fields: the first readable number; other numbers and an extension go in the note. */
function rowOf(cells: string[], columns: ColumnMap) {
  const fields: Partial<Record<TextField, string>> = {}
  const phoneCells: string[] = []
  columns.forEach((field, col) => {
    const text = cells[col]?.trim()
    if (field === 'skip' || !text) return
    if (field === 'phone') return void phoneCells.push(text)
    const join = JOIN[field]
    if (!fields[field]) fields[field] = text
    else if (join) fields[field] += join + text
  })
  const numbers = [...new Set(phoneCells.flatMap(importPhones))]
  const extension = phoneCells.map(t => splitExtension(t).extension).find(Boolean)
  const extra = [
    extension && `Extension ${extension}`,
    ...numbers.slice(1).map(n => `Other number: ${formatNumber(n)}`),
  ].filter(Boolean)
  if (numbers[0] && extra.length) fields.note = [fields.note, ...extra].filter(Boolean).join('\n')
  let shortened = false
  for (const field of Object.keys(fields) as TextField[]) {
    if (fields[field]!.length <= CONTACT_IMPORT_LIMITS[field]) continue
    fields[field] = fields[field]!.slice(0, CONTACT_IMPORT_LIMITS[field]).trim()
    shortened = true
  }
  return { fields, phone: numbers[0] ?? null, phoneText: phoneCells.join(' / '), shortened }
}

/**
 * The rows of the file (without the header) as contacts to import, checked against the existing ones
 * (deleted ones included, as contact.import skips their numbers). `firstRow` is the spreadsheet row number of data[0].
 */
export function planImport(
  data: string[][],
  columns: ColumnMap,
  existing: Iterable<Contact>,
  firstRow = 2,
): ImportPlan {
  const phones = new Map<string, 'live' | 'deleted'>()
  const emails = new Set<string>()
  for (const c of existing) {
    // A merged contact's number fills the contact it went into.
    phones.set(c.phone, c.deleted_at && !c.merged_into ? 'deleted' : 'live')
    if (!c.deleted_at && emailKey(c.email)) emails.add(emailKey(c.email)!)
  }
  const byPhone = new Map<string, ImportRow>()
  const plan: ImportPlan = { rows: [], added: 0, matched: 0, unreadable: [], repeated: 0, deleted: 0, shortened: 0 }
  data.forEach((cells, i) => {
    if (!hasText(cells)) return
    const { fields, phone, phoneText, shortened } = rowOf(cells, columns)
    if (!phone) return void plan.unreadable.push({ row: firstRow + i, text: phoneText })
    if (phones.get(phone) === 'deleted') return void plan.deleted++
    if (shortened) plan.shortened++
    const earlier = byPhone.get(phone)
    if (earlier) {
      plan.repeated++
      for (const f of IMPORT_FIELDS) if (f !== 'phone' && !earlier[f] && fields[f]) earlier[f] = fields[f]
      return
    }
    const entry: ImportRow = { ...fields, phone }
    byPhone.set(phone, entry)
    plan.rows.push(entry)
    if (phones.has(phone) || (emailKey(entry.email) && emails.has(emailKey(entry.email)!))) plan.matched++
    else plan.added++
  })
  return plan
}
