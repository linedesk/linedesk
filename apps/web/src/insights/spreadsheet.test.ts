import { describe, expect, test } from 'vitest'
import { columnName, crc32, csvCell, toCsv, toXlsx } from './spreadsheet.ts'

describe('csv', () => {
  test('quotes, a byte order mark, and no formulas', () => {
    expect(csvCell('a, "b"')).toBe('"a, ""b"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(-12)).toBe('-12')
    expect(toCsv({ header: ['A', 'B'], rows: [[1, null]] })).toBe('﻿A,B\r\n1,\r\n')
  })
})

describe('xlsx', () => {
  test('column names and the checksum', () => {
    expect([0, 25, 26, 27].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB'])
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  test('a zip with the workbook parts, text escaped and never a formula', () => {
    const bytes = toXlsx(
      {
        header: ['Date', 'Note'],
        rows: [
          ['2026-11-13', '<b>&=SUM(A1)'],
          ['2026-11-14', 3],
        ],
      },
      'Totals',
      'Nov 13',
    )
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    const text = new TextDecoder().decode(bytes)
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'])
      expect(text).toContain(part)
    expect(text).toContain('&lt;b&gt;&amp;=SUM(A1)')
    expect(text).toContain('<v>3</v>')
    expect(text).not.toContain('<f>')
  })
})
