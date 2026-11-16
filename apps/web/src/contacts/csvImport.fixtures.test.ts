// Real files as spreadsheets and other contact apps save them (csv-fixtures/), read the way the import
// dialog reads a picked file: bytes → text → table → columns → plan.
import { readFileSync } from 'node:fs'
import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import {
  type CsvTable,
  decodeCsvFile,
  fileSizeProblem,
  guessColumns,
  MAX_FILE_BYTES,
  parseCsv,
  planImport,
  tableOf,
} from './csvImport.ts'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./csv-fixtures/${name}`, import.meta.url)))

/** What the dialog shows for a file: its problem, or its table and the plan with guessed columns. */
function load(name: string, existing: Contact[] = []) {
  const decoded = decodeCsvFile(fixture(name))
  if ('problem' in decoded) return { problem: decoded.problem }
  const table = tableOf(parseCsv(decoded.text))
  if ('problem' in table) return { problem: table.problem }
  const columns = guessColumns(table.header)
  return { table, columns, plan: planImport(table.data, columns, existing, table.firstRow) }
}
const loaded = (name: string, existing?: Contact[]) => {
  const result = load(name, existing)
  if (!('plan' in result)) throw new Error(`${name}: ${result.problem}`)
  return result as { table: CsvTable; columns: ReturnType<typeof guessColumns>; plan: ReturnType<typeof planImport> }
}
const contact = (over: Partial<Contact>) =>
  ({ id: over.phone, email: null, deleted_at: null, merged_into: null, ...over }) as Contact

describe('files Excel saves', () => {
  it('UTF-8 with BOM and CRLF', () => {
    expect(loaded('02-excel-utf8-bom.csv').plan.rows).toEqual([
      { phone: '+15035550211', name: 'José Müller', email: 'jose@mueller.test' },
      { phone: '+15035550212', name: 'Zoë Ångström', email: 'zoe@angstrom.test' },
    ])
  })

  it('German Excel: Windows-1252, semicolons, Vorname and Nachname joined, German headers', () => {
    const { columns, plan } = loaded('03-excel-de-cp1252-semicolon.csv')
    expect(columns).toEqual(['name', 'name', 'phone', 'email', 'company', 'address', 'note'])
    expect(plan.rows[0]).toEqual({
      phone: '+49301234567',
      name: 'Jürgen Weiß',
      email: 'juergen@weiss.test',
      company: 'Bäckerei Weiß GmbH',
      address: 'Hauptstraße 5',
      note: 'Grüße, ruft öfter an',
    })
    expect(plan.rows.map(r => r.phone)).toEqual(['+49301234567', '+49897654321', '+15035550221'])
    // Browsers decode 0x80 as €; Node's windows-1252 is Latin-1, so the test stops before it.
    expect(plan.rows[2]).toMatchObject({ name: 'François Lefèvre', note: expect.stringMatching(/^Preis: 12,50/) })
  })

  it('UTF-16 "Unicode text", tab separated', () => {
    expect(loaded('24-utf16-excel-unicode.csv').plan.rows).toEqual([
      { phone: '+49305551234', name: 'Ümit Öztürk', company: 'Öztürk & Söhne' },
    ])
  })

  it('tab separated and old Mac line breaks (CR only)', () => {
    expect(loaded('23-tab-separated.csv').plan.rows).toEqual([
      { phone: '+15035550341', name: 'Tab Person', email: 'tab@person.test' },
    ])
    expect(loaded('25-mac-classic-cr.csv').plan.rows.map(r => r.name)).toEqual(['CR Only', 'CR Two'])
  })
})

describe('content', () => {
  it('quoted fields with commas, doubled quotes and line breaks', () => {
    expect(loaded('04-quoted-fields.csv').plan.rows).toEqual([
      { phone: '+15035550231', name: 'Patel, Sam', note: 'Said "call after 5"\nGate code 12', company: 'Acme, Inc.' },
      { phone: '+15035550232', name: 'O\'Brien "Bud"', note: 'multi\r\nline\r\nnote' },
      { phone: '+15035550233', name: 'Ann' },
    ])
  })

  it('several phone columns: the first readable number, the others in the note', () => {
    expect(loaded('05-headers-german.csv').plan.rows.map(r => r.phone)).toEqual(['+4915123456789', '+49405551234'])
    const { columns, plan } = loaded('06-headers-mixed-case.csv')
    expect(columns).toEqual(['name', 'name', 'phone', 'phone', 'email', 'company'])
    expect(plan.rows).toEqual([
      {
        phone: '+15035550241',
        name: 'Mia Jones',
        email: 'MIA@JONES.TEST',
        company: 'Jones LLC',
        note: 'Other number: +1 503 555 0299',
      },
      { phone: '+15035550242', name: 'Noah Kim', email: 'noah@kim.test' },
    ])
  })

  it('skips empty rows and names unreadable ones by their spreadsheet row', () => {
    const { plan } = loaded('09-empty-rows.csv')
    expect(plan.rows.map(r => r.name)).toEqual(['Alex Roe', 'Bea Lee'])
    expect(plan.unreadable).toEqual([{ row: 10, text: '', problem: 'missing' }])
  })

  it('finds the header below a title line', () => {
    const { table, plan } = loaded('26-header-not-first-line.csv')
    expect(table.header).toEqual(['Name', 'Phone'])
    expect(plan.rows).toEqual([{ phone: '+15035550361', name: 'Late Header' }])
  })

  it('combines repeated numbers; one email with two numbers stays two contacts', () => {
    const { plan } = loaded('10-duplicate-rows.csv')
    expect(plan).toMatchObject({ added: 2, repeated: 2 })
    expect(plan.rows[0]).toEqual({
      phone: '+15035550271',
      name: 'Carl Diaz',
      email: 'carl@diaz.test',
      company: 'Diaz Plumbing',
    })
  })

  it('counts rows of existing and deleted contacts as contact.import treats them', () => {
    const existing = [
      contact({ phone: '+15035550171', email: 'grace@lindqvist.test' }),
      contact({ phone: '+15035550117' }),
      contact({ phone: '+15035550153' }),
      contact({ phone: '+15035550126', deleted_at: '2026-01-01T00:00:00Z' }),
    ]
    const { plan } = loaded('11-existing-contacts.csv', existing)
    // 0171, 0117, 0153 by number, 0179 by Grace's email; Marcus (0126) was deleted.
    expect(plan).toMatchObject({ added: 1, matched: 4, deleted: 1 })
    expect(plan.rows.map(r => r.phone)).not.toContain('+15035550126')
  })

  it('reads numbers with 00, (0), extensions and two numbers in a cell; leaves out what is not a number', () => {
    const { plan } = loaded('12-phone-formats.csv')
    expect(plan.rows.map(r => [r.name, r.phone])).toEqual([
      ['US dashes', '+15035550291'],
      ['US dots with +1', '+15035550292'],
      ['US leading 1', '+15035550293'],
      ['Germany +49', '+493012345678'],
      ['Germany 0049', '+493012345679'],
      ['UK with (0)', '+442079460958'],
      ['France', '+33199005300'],
      ['Two numbers', '+15035550296'],
    ])
    expect(plan.unreadable.map(u => u.row)).toEqual([9, 10, 11, 12, 13, 14, 15])
    // Every number is one contact.import takes, so no row can make the server refuse the import.
    for (const row of plan.rows) expect(row.phone).toMatch(/^\+[1-9]\d{6,14}$/)
    const ext = loaded('13-extensions.csv').plan
    expect(ext.unreadable).toEqual([])
    expect(ext.rows[0]).toEqual({ phone: '+15035550301', name: 'ext dot', note: 'Extension 12' })
  })

  it('cuts values longer than a contact keeps', () => {
    const long = `Name,Phone,Note\n${'N'.repeat(300)},5035550321,${'Z'.repeat(5000)}\nShort,5035550322,ok\n`
    const table = tableOf(parseCsv(long)) as CsvTable
    const plan = planImport(table.data, guessColumns(table.header), [], table.firstRow)
    expect(plan.shortened).toBe(1)
    expect([plan.rows[0]!.name!.length, plan.rows[0]!.note!.length]).toEqual([200, 2000])
  })
})

describe('files that are not imported', () => {
  it('says why in plain words', () => {
    expect(load('17-empty-0-bytes.csv')).toEqual({ problem: 'The file is empty.' })
    expect(load('18-header-only.csv')).toEqual({
      problem: 'The file has no rows under its column names. The first row names the columns.',
    })
    expect(load('19-png-renamed.csv').problem).toMatch(/^This file is not a CSV file/)
    expect(load('21-xlsx-renamed.csv').problem).toMatch(/^This is an Excel workbook/)
    expect(fileSizeProblem(MAX_FILE_BYTES)).toBeNull()
    expect(fileSizeProblem(13.4 * 1024 * 1024)).toBe(
      'The file is 13.4 MB; files up to 10 MB can be imported. Split it into smaller files.',
    )
  })
})

describe('a long file', () => {
  it('plans 5,200 rows', () => {
    const lines = Array.from(
      { length: 5200 },
      (_, i) => `Person ${i},503-6${String(i).padStart(5, '0').slice(0, 2)}-${String(i).padStart(5, '0').slice(2)}0`,
    )
    const table = tableOf(parseCsv(`Name,Phone\n${lines.join('\n')}\n`)) as CsvTable
    const plan = planImport(table.data, guessColumns(table.header), [], table.firstRow)
    expect(plan).toMatchObject({ added: 5200, repeated: 0, unreadable: [] })
  })
})
