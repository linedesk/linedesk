// Makes apps/api/src/de-areas.data.ts: every German Ortsnetz (local area code, ONKz) with its name, and every German
// municipality (Gemeinde) with the postcode of its town hall and the Ortsnetz its centre lies in, so a number can be
// asked for in any German area and an address can suggest its area (Dossenheim → Heidelberg 06221).
// docs/numbers-kyc.md, "Area codes". Run again when the Bundesnetzagentur or Destatis publish a new edition.
//
// Sources (download them, then pass the paths):
// 1. Bundesnetzagentur, Vorwahlverzeichnis (VwV), the CSV in the zip on
//    https://www.bundesnetzagentur.de/DE/Fachthemen/Telekommunikation/Nummerierung/ONRufnr/Einteilung_ONB/artikel.html
//    (`NVONB.INTERNET.<date>.ONB.csv`). Datenlizenz Deutschland – Namensnennung – Version 2.0 (the BNetzA's copyright
//    note: its .csv data is under dl-de/by-2-0 unless marked otherwise).
// 2. Bundesnetzagentur, ONB-Grenzen (GIS data of the Ortsnetz boundaries, ArcView shapefile, DHDN Gauß-Krüger zone 3,
//    EPSG:31467), same page. Used only to look up which Ortsnetz a municipality's centre lies in; no geometry is kept.
// 3. Statistisches Bundesamt (Destatis), Gemeindeverzeichnis, "Gemeinden in Deutschland nach Fläche, Bevölkerung und
//    Postleitzahl" (`AuszugGV<n>QAktuell.xlsx`), https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/
//    Gemeindeverzeichnis/_inhalt.html. "Vervielfältigung und Verbreitung, auch auszugsweise, mit Quellenangabe
//    gestattet."
// 4. Bundesnetzagentur, Verzeichnis der zugeteilten Rufnummernblöcke in Ortsnetzen (`NVONB.INTERNET.<date>.OZRNB.csv` in
//    https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/Telekommunikation/Nummerierung/ONRufnr/NVONB.INTERNET.OZRNB.zip),
//    dl-de/by-2-0 like source 1. Only the blocks of the carriers in CARRIERS are kept: Linedesk Cloud offers German
//    numbers only where its carrier holds blocks of its own (BNetzA Mitteilung 90/2026, docs/numbers-kyc.md).
//
// Usually not run by hand: `pnpm --filter @linedesk/api de-areas:update` (scripts/de-areas-update.ts) downloads the
// newest edition of every source and runs this; .github/workflows/de-areas.yml does that every week and opens a PR.
// By hand: node apps/api/scripts/de-areas.ts <ONB.csv> <ONB_…_Gauss3d-3.shp> <AuszugGV….xlsx> <OZRNB.csv>
//   [--boundaries-date=YYYY-MM-DD] (the date of the ONB-Grenzen edition, from its zip's name; it is not in the files)
// Needs `unzip` (to read the xlsx). No dependencies. Every source is checked for the format this script knows (columns,
// file names, the shapefile's projection): a change throws instead of writing a broken file.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=', 2) as [string, string | undefined]),
)
const [csvPath, shpPath, xlsxPath, blocksPath, extra] = args.filter(a => !a.startsWith('--'))
const boundariesDate = flags['boundaries-date']
const unknownFlags = Object.keys(flags).filter(f => f !== 'boundaries-date')
if (
  !csvPath ||
  !shpPath ||
  !xlsxPath ||
  !blocksPath ||
  extra ||
  unknownFlags.length ||
  (boundariesDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(boundariesDate))
) {
  console.error(
    'usage: node apps/api/scripts/de-areas.ts <ONB.csv> <ONB shapefile .shp> <Destatis AuszugGV .xlsx> <OZRNB.csv> [--boundaries-date=YYYY-MM-DD]',
  )
  process.exit(1)
}

/** "NVONB.INTERNET.20261106.OZRNB.csv" → "2026-11-06": the BNetzA dates each edition in the file name. */
function dateInName(path: string, kind: 'ONB' | 'OZRNB'): string {
  const m = new RegExp(`^NVONB\\.INTERNET\\.(\\d{4})(\\d{2})(\\d{2})\\.${kind}\\.csv$`).exec(basename(path))
  if (!m) throw new Error(`${basename(path)} is not named NVONB.INTERNET.<yyyymmdd>.${kind}.csv`)
  return `${m[1]}-${m[2]}-${m[3]}`
}
const vwvDate = dateInName(csvPath, 'ONB')
const blocksDate = dateInName(blocksPath, 'OZRNB')

/** The first line of a CSV must be exactly this: a new or moved column fails here instead of shifting the data. */
function checkHeader(text: string, expected: string, file: string) {
  const header = text
    .split(/\r?\n/, 1)[0]!
    .replace(/^\uFEFF/, '')
    .trim()
  if (header !== expected) throw new Error(`${file}: the columns changed. Expected "${expected}", got "${header}"`)
}
/** The carriers (by their BNetzA porting ID, Portierungskennung) whose number blocks are kept: Telnyx Ireland Ltd. */
const CARRIERS = ['D451']
const OUT = new URL('../src/de-areas.data.ts', import.meta.url)

// ---- Ortsnetze (VwV) ----

type Ortsnetz = { onkz: string; name: string }
const ortsnetze: Ortsnetz[] = []
const vwv = readFileSync(csvPath, 'utf8')
checkHeader(vwv, 'Ortsnetzkennzahl;Ortsnetzname;KennzeichenAktiv', basename(csvPath))
for (const line of vwv.split(/\r?\n/).slice(1)) {
  const [onkz, name, active] = line.split(';')
  if (!onkz || !name || active?.trim() !== '1') continue
  if (!/^\d{2,5}$/.test(onkz)) throw new Error(`bad area code ${onkz}`)
  ortsnetze.push({ onkz, name: name.trim() })
}
const known = new Set(ortsnetze.map(o => o.onkz))

// ---- Ortsnetz boundaries (shapefile: polygons, and the dbf's ONB_NUMMER) ----

type Area = { onkz: string; box: [number, number, number, number]; rings: Float64Array[] }
function readAreas(path: string): Area[] {
  // The point-in-polygon below projects to DHDN Gauß-Krüger zone 3 (EPSG:31467); another projection would put every
  // municipality into the wrong Ortsnetz without any other error.
  const prj = path.replace(/\.shp$/i, '.prj')
  if (!existsSync(prj) || !/Gauss.*Zone_3|EPSG",\s*31467/i.test(readFileSync(prj, 'utf8')))
    throw new Error(`${basename(prj)}: not DHDN Gauß-Krüger zone 3 (EPSG:31467)`)
  const shp = readFileSync(path)
  const dbf = readFileSync(path.replace(/\.shp$/i, '.dbf'))
  // dbf: header, field descriptors (32 bytes each, ended by 0x0d), then fixed-length records.
  const records = dbf.readUInt32LE(4)
  const headerLength = dbf.readUInt16LE(8)
  const recordLength = dbf.readUInt16LE(10)
  let offset = 32
  let fieldOffset = 1
  let onkzField: { at: number; length: number } | null = null
  while (dbf[offset] !== 0x0d) {
    const name = dbf
      .subarray(offset, offset + 11)
      .toString('latin1')
      .replace(/\0.*$/, '')
    const length = dbf[offset + 16]!
    if (name === 'ONB_NUMMER') onkzField = { at: fieldOffset, length }
    fieldOffset += length
    offset += 32
  }
  if (!onkzField) throw new Error('ONB_NUMMER not in the dbf')
  const codes: string[] = []
  for (let r = 0; r < records; r++) {
    const at = headerLength + r * recordLength + onkzField.at
    codes.push(
      dbf
        .subarray(at, at + onkzField.length)
        .toString('latin1')
        .trim(),
    )
  }
  // shp: 100-byte header, then records (big-endian number and length, little-endian content).
  const areas: Area[] = []
  let at = 100
  let index = 0
  while (at < shp.length) {
    const length = shp.readInt32BE(at + 4) * 2
    const content = at + 8
    const type = shp.readInt32LE(content)
    if (type === 5) {
      const box: Area['box'] = [
        shp.readDoubleLE(content + 4),
        shp.readDoubleLE(content + 12),
        shp.readDoubleLE(content + 20),
        shp.readDoubleLE(content + 28),
      ]
      const parts = shp.readInt32LE(content + 36)
      const points = shp.readInt32LE(content + 40)
      const starts = Array.from({ length: parts }, (_, i) => shp.readInt32LE(content + 44 + i * 4))
      const base = content + 44 + parts * 4
      const rings = starts.map((start, i) => {
        const end = i + 1 < parts ? starts[i + 1]! : points
        const ring = new Float64Array((end - start) * 2)
        for (let p = start; p < end; p++) {
          ring[(p - start) * 2] = shp.readDoubleLE(base + p * 16)
          ring[(p - start) * 2 + 1] = shp.readDoubleLE(base + p * 16 + 8)
        }
        return ring
      })
      areas.push({ onkz: codes[index]!, box, rings })
    }
    at = content + length
    index++
  }
  return areas
}

/** Even-odd over every ring of the area, so holes (an enclave of another Ortsnetz) are outside. */
function inside(area: Area, x: number, y: number): boolean {
  const [minX, minY, maxX, maxY] = area.box
  if (x < minX || x > maxX || y < minY || y > maxY) return false
  let odd = false
  for (const ring of area.rings) {
    const n = ring.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2]!
      const yi = ring[i * 2 + 1]!
      const xj = ring[j * 2]!
      const yj = ring[j * 2 + 1]!
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd
    }
  }
  return odd
}

// ---- WGS84 (ETRS89) → DHDN Gauß-Krüger zone 3 ----

const RAD = Math.PI / 180
const SEC = RAD / 3600
type Ellipsoid = { a: number; f: number }
const WGS84: Ellipsoid = { a: 6378137, f: 1 / 298.257223563 }
const BESSEL: Ellipsoid = { a: 6377397.155, f: 1 / 299.1528128 }

function toCartesian(lat: number, lon: number, { a, f }: Ellipsoid): [number, number, number] {
  const e2 = f * (2 - f)
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  return [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)]
}

function toGeographic([x, y, z]: [number, number, number], { a, f }: Ellipsoid): [number, number] {
  const e2 = f * (2 - f)
  const p = Math.hypot(x, y)
  let lat = Math.atan2(z, p * (1 - e2))
  for (let i = 0; i < 10; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
    lat = Math.atan2(z + e2 * n * Math.sin(lat), p)
  }
  return [lat, Math.atan2(y, x)]
}

/**
 * WGS84 to DHDN: the inverse of the common 7-parameter shift DHDN → WGS84 (EPSG:1777's values: 598.1, 73.7, 418.2 m;
 * 0.202, 0.045, −2.455″; 6.7 ppm), applied with the opposite signs. A few metres off at most, which is far below the
 * size of an Ortsnetz.
 */
function wgs84ToDhdn(lat: number, lon: number): [number, number] {
  const [x, y, z] = toCartesian(lat * RAD, lon * RAD, WGS84)
  const [tx, ty, tz] = [-598.1, -73.7, -418.2]
  const [rx, ry, rz] = [-0.202 * SEC, -0.045 * SEC, 2.455 * SEC]
  const s = 1 - 6.7e-6
  // Position-vector rotation (small angles).
  const out: [number, number, number] = [
    tx + s * (x - rz * y + ry * z),
    ty + s * (rz * x + y - rx * z),
    tz + s * (-ry * x + rx * y + z),
  ]
  return toGeographic(out, BESSEL)
}

/** Transverse Mercator on the Bessel ellipsoid, central meridian 9°, false easting 3 500 000 m, scale 1. */
function gaussKrueger(lat: number, lon: number): [number, number] {
  const { a, f } = BESSEL
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const l = lon - 9 * RAD
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  const t = Math.tan(lat)
  const c = ep2 * Math.cos(lat) ** 2
  const A = l * Math.cos(lat)
  const e4 = e2 * e2
  const e6 = e4 * e2
  const m =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * lat -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * lat) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * lat) -
      ((35 * e6) / 3072) * Math.sin(6 * lat))
  const x = n * (A + ((1 - t * t + c) * A ** 3) / 6 + ((5 - 18 * t * t + t ** 4 + 72 * c - 58 * ep2) * A ** 5) / 120)
  const y =
    m +
    n *
      t *
      (A ** 2 / 2 +
        ((5 - t * t + 9 * c + 4 * c * c) * A ** 4) / 24 +
        ((61 - 58 * t * t + t ** 4 + 600 * c - 330 * ep2) * A ** 6) / 720)
  return [3_500_000 + x, y]
}

// ---- Gemeinden (Destatis xlsx: shared strings and the second sheet's rows) ----

const unzip = (entry: string) =>
  execFileSync('unzip', ['-p', xlsxPath, entry], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
const xmlText = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
const shared = [...unzip('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1]!))
const sheet = unzip('xl/worksheets/sheet2.xml')
/** "Gebietsstand: 30.06.2026 (2. Quartal)" → "2026-06-30": the edition's date, for the header. */
const gvDate = (() => {
  const m = shared.map(t => /Gebietsstand:?\s*(?:am\s*)?(\d{2})\.(\d{2})\.(\d{4})/.exec(t)).find(Boolean)
  if (!m) throw new Error(`${basename(xlsxPath)}: no "Gebietsstand" date in the workbook`)
  return `${m[3]}-${m[2]}-${m[1]}`
})()

type Gemeinde = { name: string; plz: string; lat: number; lon: number }
const gemeinden: Gemeinde[] = []
for (const row of sheet.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
  const cells: Record<string, string> = {}
  for (const c of row[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const value = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? '')?.[1]
    if (value === undefined) continue
    cells[c[1]!] = /t="s"/.test(c[2]!) ? shared[Number(value)]! : xmlText(value)
  }
  // Satzart 60: a municipality. H name, N postcode of the town hall, O longitude, P latitude (decimal comma).
  // Textkennzeichen 65 and 66: unincorporated land (forests, lakes, military areas), mostly without a postcode.
  if (cells.A !== '60' || ((cells.B === '65' || cells.B === '66') && !cells.N)) continue
  const lon = Number((cells.O ?? '').replace(',', '.'))
  const lat = Number((cells.P ?? '').replace(',', '.'))
  if (!cells.H || !/^\d{5}$/.test(cells.N ?? '') || !lat || !lon) throw new Error(`bad row ${JSON.stringify(cells)}`)
  // Inside Germany's bounding box: moved or swapped coordinate columns fail here.
  if (lat < 47.2 || lat > 55.1 || lon < 5.8 || lon > 15.1) throw new Error(`not in Germany: ${JSON.stringify(cells)}`)
  // "Heidelberg, Stadt", "München, Landeshauptstadt": the name without what it is.
  gemeinden.push({ name: cells.H.replace(/,.*$/, '').trim(), plz: cells.N!, lat, lon })
}

// ---- Which Ortsnetz each municipality's centre is in ----

const areas = readAreas(shpPath)
const rows: string[] = []
let outside = 0
for (const g of gemeinden) {
  const [lat, lon] = wgs84ToDhdn(g.lat, g.lon)
  const [x, y] = gaussKrueger(lat, lon)
  const area = areas.find(a => inside(a, x, y))
  if (!area || !known.has(area.onkz)) {
    outside++
    continue
  }
  if (/[\t\n]/.test(g.name)) throw new Error(`bad name ${g.name}`)
  rows.push(`${g.name}\t${g.plz}\t${area.onkz}`)
}
rows.sort((a, b) => a.localeCompare(b, 'de'))
if (gemeinden.length < 10_000 || ortsnetze.length < 5000 || outside > 50)
  throw new Error(`unexpected: ${gemeinden.length} municipalities, ${ortsnetze.length} areas, ${outside} outside`)

// ---- Number blocks of the carriers (OZRNB) ----

// A block is every number of its Ortsnetz that starts with its digits: "7234000" to "7234999" is "7234".
const blocks: string[] = []
const blockList = readFileSync(blocksPath, 'latin1')
checkHeader(
  blockList,
  'Ortsnetzkennzahl;Ortsnetzname;RufnummernblockVon;RufnummernblockBis;RNBGroesse;Portierungskennung;KurznameAnbieter;Zuteilungsdatum;Wirksamkeitsdatum;DatumBefristetBis;DatumAenderungenSeit',
  basename(blocksPath),
)
for (const line of blockList.split(/\r?\n/).slice(1)) {
  const [onkz, , from, to, , carrier] = line.split(';')
  if (!onkz || !from || !to || !carrier || !CARRIERS.includes(carrier)) continue
  if (!known.has(onkz)) throw new Error(`block of ${carrier} in unknown area code ${onkz}`)
  if (!/^\d+$/.test(from) || from.length !== to.length) throw new Error(`bad block ${onkz} ${from}-${to}`)
  const free = Math.min(from.match(/0*$/)![0].length, to.match(/9*$/)![0].length)
  const digits = from.slice(0, from.length - free)
  if (!digits || from !== digits.padEnd(from.length, '0') || to !== digits.padEnd(to.length, '9'))
    throw new Error(`block ${onkz} ${from}-${to} is not every number starting with some digits`)
  blocks.push(`${carrier}\t${onkz}\t${digits}`)
}
blocks.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
if (blocks.length < 50) throw new Error(`unexpected: only ${blocks.length} blocks of ${CARRIERS.join(', ')}`)

/** A single-quoted string literal, as the repo's formatter writes it. */
const quoted = (text: string) => `'${JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`

/** "2026-11-06" → "06.11.2026", as the sources write their dates. */
const german = (iso: string) => iso.split('-').reverse().join('.')
/** Wraps comment text at the formatter's 120 columns. */
function comment(text: string): string {
  const lines: string[] = []
  let line = '//'
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > 120) {
      lines.push(line)
      line = '//'
    }
    line += ` ${word}`
  }
  return `${[...lines, line].join('\n')}\n`
}
const header =
  comment('Generated by apps/api/scripts/de-areas.ts; do not edit. docs/numbers-kyc.md, "Area codes".') +
  comment(
    `Sources: Bundesnetzagentur, Vorwahlverzeichnis (${basename(csvPath)}, ${german(vwvDate)}), dl-de/by-2-0; ` +
      `Bundesnetzagentur, ONB-Grenzen (${basename(shpPath)}${boundariesDate ? `, ${german(boundariesDate)}` : ''}), ` +
      "only to find the Ortsnetz of each municipality's centre; Statistisches Bundesamt (Destatis), " +
      `Gemeindeverzeichnis (${basename(xlsxPath)}, Gebietsstand ${german(gvDate)}), reproduced with the source named; ` +
      'Bundesnetzagentur, Verzeichnis der zugeteilten Rufnummernblöcke in Ortsnetzen ' +
      `(${basename(blocksPath)}, ${german(blocksDate)}), dl-de/by-2-0.`,
  )
const editions = {
  vorwahlverzeichnis: vwvDate,
  onbGrenzen: boundariesDate ?? null,
  gemeindeverzeichnis: gvDate,
  rufnummernbloecke: blocksDate,
}
writeFileSync(
  OUT,
  `${header}
/** Every active German Ortsnetz: "<area code without the 0>\\t<name>" per line, by area code. */
// i18n-ignore: official place names (data, not UI text)
export const DE_ORTSNETZE =
  ${quoted(ortsnetze.map(o => `${o.onkz}\t${o.name}`).join('\n'))}

/** Every German municipality: "<name>\\t<postcode of its town hall>\\t<area code of its centre>" per line, by name. */
// i18n-ignore: official place names (data, not UI text)
export const DE_GEMEINDEN =
  ${quoted(rows.join('\n'))}

/**
 * The number blocks of the carriers Linedesk Cloud orders German numbers from: "<porting ID>\\t<area code>\\t<first
 * digits of every number of the block>" per line.
 */
export const DE_CARRIER_BLOCKS =
  ${quoted(blocks.join('\n'))}

/**
 * The date of each source's edition (ISO). CI warns when the block list is older than 75 days
 * (scripts/de-areas-age.ts); the weekly workflow .github/workflows/de-areas.yml makes a new file.
 */
export const DE_AREAS_EDITIONS = {
${Object.entries(editions)
  .map(([k, v]) => `  ${k}: ${v === null ? 'null' : `'${v}'`},`)
  .join('\n')}
} as const
`,
)
console.log(
  `${ortsnetze.length} Ortsnetze, ${rows.length} municipalities (${outside} centres outside every Ortsnetz), ${blocks.length} blocks of ${CARRIERS.join(', ')} → ${OUT.pathname}`,
)
