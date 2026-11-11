import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { guessColumns, importPhone, parseCsv, planImport } from './csvImport.ts'

const contact = (over: Partial<Contact>) =>
  ({ id: 'k', phone: '+15035550142', email: null, deleted_at: null, ...over }) as Contact

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks; CRLF; skips empty lines', () => {
    const text =
      '﻿Name,Phone,Note\r\n"Patel, Sam",503-555-0142,"Said ""call after 5""\nGate code 12"\r\n\r\nDana,(503) 555 0199,\n'
    expect(parseCsv(text)).toEqual([
      ['Name', 'Phone', 'Note'],
      ['Patel, Sam', '503-555-0142', 'Said "call after 5"\nGate code 12'],
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
  it('maps common headers, each field to its first column, the rest skipped', () => {
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
    ).toEqual(['name', 'phone', 'email', 'company', 'address', 'note', 'skip', 'skip'])
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
    expect(plan).toMatchObject({ added: 1, matched: 2, unreadable: [4, 6], repeated: 1 })
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
      ].map(importPhone),
    ).toEqual(['+15035550142', '+15035550142', '+15035550142', '+49301234567', '+442079460958', null, null])
  })
})
