// Files for the Insights export, built in the browser: CSV (UTF-8 with a byte order mark, so Excel reads
// the characters right) and a minimal Excel workbook (.xlsx: one sheet, a bold header row, text and
// numbers), written by hand so the web app needs no spreadsheet library.

export type Cell = string | number | null | undefined
export type Table = { header: string[]; rows: Cell[][] }

/** One CSV cell: quoted when needed; text a spreadsheet would run as a formula gets a leading apostrophe. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && (/^[=@\t\r]/.test(text) || /^[+-](?![\d\s().]*$)/.test(text))) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(table: Table): string {
  const line = (cells: Cell[]) => cells.map(csvCell).join(',')
  return `﻿${[line(table.header), ...table.rows.map(line)].join('\r\n')}\r\n`
}

// --- XLSX ----------------------------------------------------------------------------------------

const xml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    // Characters XML 1.0 does not allow (control characters a summary might carry).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')

/** "A", "B", …, "Z", "AA". */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function cellXml(value: Cell, ref: string, bold: boolean): string {
  const style = bold ? ' s="1"' : ''
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`
  // Inline strings are never formulas, so nothing a caller said can run.
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`
}

function sheetXml(table: Table, note: string | undefined): string {
  const rows: string[] = []
  let r = 1
  if (note) rows.push(`<row r="${r}">${cellXml(note, `A${r++}`, false)}</row>`)
  const headerRow = r
  rows.push(`<row r="${r}">${table.header.map((h, i) => cellXml(h, `${columnName(i)}${r}`, true)).join('')}</row>`)
  r++
  for (const cells of table.rows) {
    rows.push(`<row r="${r}">${cells.map((v, i) => cellXml(v, `${columnName(i)}${r}`, false)).join('')}</row>`)
    r++
  }
  const widths = table.header.map((h, i) => {
    const longest = Math.max(h.length, ...table.rows.slice(0, 200).map(row => String(row[i] ?? '').length))
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, longest + 2))}" customWidth="1"/>`
  })
  const freeze = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${widths.join('')}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

function workbookFiles(table: Table, sheetName: string, note?: string): [string, string][] {
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))
  return [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(table, note)],
  ]
}

// A ZIP archive with stored (uncompressed) entries: all an .xlsx needs to open.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zip(files: [string, string][]): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [path, text] of files) {
    const name = encoder.encode(path)
    const data = encoder.encode(text)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, data)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, data.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    central.push(new Uint8Array(entry.buffer), name)
    offset += 30 + name.length + data.length
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The table as an .xlsx file; `note` (the period and time zone) goes in the first row. */
export function toXlsx(table: Table, sheetName: string, note?: string): Uint8Array {
  return zip(workbookFiles(table, sheetName, note))
}

/** Saves a file through the browser. */
export function saveFile(filename: string, content: string | Uint8Array, type: string) {
  const blob = new Blob([content as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const CSV_TYPE = 'text/csv;charset=utf-8'
