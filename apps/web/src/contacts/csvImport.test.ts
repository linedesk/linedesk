import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { toCsv } from '../insights/spreadsheet.ts'
import {
  decodeCsvFile,
  EXAMPLE_CONTACTS,
  guessColumns,
  IMPORT_FIELDS,
  importPhone,
  parseCsv,
  planImport,
  planSummary,
  tableOf,
} from './csvImport.ts'

const contact = (over: Partial<Contact>) =>
  ({ id: 'k', phone: '+15035550142', email: null, deleted_at: null, ...over }) as Contact

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks; CRLF; keeps empty lines so rows keep their numbers', () => {
    const text =
      '﻿Name,Phone,Note\r\n"Patel, Sam",503-555-0142,"Said ""call after 5""\nGate code 12"\r\n\r\nDana,(503) 555 0199,\n'
    expect(parseCsv(text)).toEqual([
      ['Name', 'Phone', 'Note'],
      ['Patel, Sam', '503-555-0142', 'Said "call after 5"\nGate code 12'],
      [''],
      ['Dana', '(503) 555 0199', ''],
    ])
  })

  it('reads semicolon files (spreadsheets in many countries export those)', () => {
    expect(parseCsv('Name;Telefon\nSam;5035550142')).toEqual([
      ['Name', 'Telefon'],
      ['Sam', '5035550142'],
    ])
  })
})

describe('guessColumns', () => {
  it('maps common headers; phone may be several columns, other fields their first column; the rest skipped', () => {
    expect(
      guessColumns([
        'Full name',
        'Mobile phone',
        'E-mail',
        'Company',
        'Street address',
        'Notes',
        'Second phone',
        'Birthday',
      ]),
    ).toEqual(['name', 'phone', 'email', 'company', 'address', 'note', 'phone', 'skip'])
  })
})

describe('planImport', () => {
  it('normalizes numbers, merges repeats in the file, counts new and matching rows, lists unreadable ones', () => {
    const rows = [
      ['Sam Patel', '503-555-0142', ''],
      ['Grace', '(503) 555-0177', 'grace@example.com'],
      ['Grace L.', '+1 503 555 0177', ''],
      ['Dana', '', 'dana@example.com'],
      ['Known by email', '5035550188', 'KNOWN@example.com'],
      ['Nobody', 'call me', ''],
    ]
    const plan = planImport(
      rows,
      ['name', 'phone', 'email'],
      [contact({}), contact({ id: 'e', phone: '+15035550100', email: 'known@example.com' })],
    )
    expect(plan.rows).toEqual([
      { name: 'Sam Patel', phone: '+15035550142' },
      { name: 'Grace', phone: '+15035550177', email: 'grace@example.com' },
      { name: 'Known by email', phone: '+15035550188', email: 'KNOWN@example.com' },
    ])
    expect(plan).toMatchObject({
      added: 1,
      matched: 2,
      unreadable: [
        { row: 5, text: '' },
        { row: 7, text: 'call me' },
      ],
      repeated: 1,
    })
  })

  it('counts two numbers with one email as two new contacts, like contact.import', () => {
    const plan = planImport(
      [
        ['Hannah Cole', '503 555 0298', 'hannah@example.com'],
        ['Hannah C.', '503 555 0299', 'Hannah@example.com'],
      ],
      ['name', 'phone', 'email'],
      [],
    )
    expect(plan).toMatchObject({ added: 2, matched: 0 })
  })
})

describe('importPhone', () => {
  it('takes US numbers as written and other countries with + and their code', () => {
    expect(
      [
        '503.555.0142',
        '1 (503) 555-0142',
        '+1 503 555 0142',
        '+49 30 1234567',
        '+44 20 7946 0958',
        '555-0142',
        '+1 555',
      ].map(t => importPhone(t)),
    ).toEqual(['+15035550142', '+15035550142', '+15035550142', '+49301234567', '+442079460958', null, null])
  })

  it('never turns a national number of another country into a made-up +1 number', () => {
    // Ten digits with a trunk 0 is no US number: refused, not +1 031… .
    expect(importPhone('03-1234-5678')).toBeNull()
    expect(importPhone('020 7946 0958')).toBeNull()
  })

  it('reads national numbers the way the workspace country writes them', () => {
    expect(importPhone('020 7946 0958', 'GB')).toBe('+442079460958')
    expect(importPhone('07400 123456', 'GB')).toBe('+447400123456')
    expect(importPhone('55 1234 5678', 'MX')).toBe('+525512345678')
    expect(importPhone('03-1234-5678', 'JP')).toBe('+81312345678')
    // With + or 00 and a country code, from anywhere.
    expect(importPhone('+1 503 555 0142', 'GB')).toBe('+15035550142')
    expect(importPhone('0044 20 7946 0958', 'GB')).toBe('+442079460958')
    // A US number written without +1 is not a UK one.
    expect(importPhone('(503) 555-0142', 'GB')).toBeNull()
  })

  it('says why a row is left out', () => {
    const plan = planImport(
      [['Alex Roe', '020 79'], ['Bea Lee', ''], ['Cy Park', '020 7946 0958 12345']],
      ['name', 'phone'],
      [],
      2,
      'GB',
    )
    expect(plan.unreadable).toEqual([
      { row: 2, text: '020 79', problem: 'too_short' },
      { row: 3, text: '', problem: 'missing' },
      { row: 4, text: '020 7946 0958 12345', problem: 'too_long' },
    ])
  })
})

describe('the example file', () => {
  it('imports cleanly with the real importer: every column mapped, every row a contact', () => {
    const decoded = decodeCsvFile(new TextEncoder().encode(toCsv(EXAMPLE_CONTACTS)))
    if ('problem' in decoded) throw new Error(decoded.problem)
    const table = tableOf(parseCsv(decoded.text))
    if ('problem' in table) throw new Error(table.problem)
    const columns = guessColumns(table.header)
    expect(columns).toEqual(['name', 'phone', 'company', 'email', 'address', 'note'])
    expect([...columns].sort()).toEqual([...IMPORT_FIELDS].sort())
    const plan = planImport(table.data, columns, [], table.firstRow)
    expect(plan).toMatchObject({ added: 4, matched: 0, unreadable: [], repeated: 0, deleted: 0, shortened: 0 })
    expect(plan.rows).toEqual([
      {
        phone: '+15035550111',
        name: 'Sam Patel',
        company: 'Patel Dental',
        email: 'sam@example.com',
        address: '1200 SW Main St, Portland, OR 97205',
      },
      { phone: '+15035550122', name: 'Dana Brooks', email: 'dana.brooks@example.com', note: 'Prefers a text message' },
      {
        phone: '+15035550133',
        name: 'Luis Ortega',
        company: 'Ortega Builders',
        address: '845 NE Alberta St, Portland, OR 97211',
        note: 'Gate code 4512, ring twice',
      },
      { phone: '+15035550144', name: 'Grace Kim', email: 'grace.kim@example.com' },
    ])
  })
})

describe('planSummary', () => {
  it('names each unreadable row with why, and where numbers need a country code', () => {
    const us = planImport([['Alex Roe', '555-01'], ['Bea Lee', '']], ['name', 'phone'], [])
    expect(planSummary(us)).toContain('2 rows without a readable phone number left out: row 2 (555-01: too short), row 3 (no number). Numbers outside the US need + and the country code.')
    const gb = planImport([['Alex Roe', '(503) 555-0142']], ['name', 'phone'], [], 2, 'GB')
    expect(planSummary(gb, 'GB')).toContain('row 2 ((503) 555-0142: not a valid number). Numbers outside the United Kingdom need + and the country code.')
  })
})
