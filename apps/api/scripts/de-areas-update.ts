// Refreshes apps/api/src/de-areas.data.ts from the newest editions of its sources: downloads them, checks them, runs
// scripts/de-areas.ts and says what changed. `pnpm --filter @linedesk/api de-areas:update`; the weekly workflow
// .github/workflows/de-areas.yml runs it and opens a PR into master-dev, so the data ships with the next release
// (docs/numbers-kyc.md, "Area codes"; decision of 2026-11-18).
//
// Where the newest files are (the sources and their licences: the comment at the top of scripts/de-areas.ts):
// - Vorwahlverzeichnis and ONB-Grenzen: the links on the BNetzA's page "Einteilung der Ortsnetzbereiche" (BNETZA_PAGE).
//   The boundaries' zip is named after its edition (Aktuelle_Grenzen_<ddmmyyyy>.zip), so the page is read every time.
// - Rufnummernblöcke: one fixed URL (OZRNB_URL) that always holds the newest list, dated in the CSV's name.
// - Gemeindeverzeichnis: Destatis keeps one file per quarter under a fixed URL (AuszugGV<1-4>QAktuell.xlsx), each the
//   newest edition of that quarter; the one with the newest Gebietsstand (its sheet's name) is taken.
//
// Fails, and writes nothing, when a link is missing or ambiguous, a download is not what it should be, the generator's
// format checks fail, or the new data shrinks much against the file it replaces (MAX_DROP): a changed format is far
// likelier than Germany losing area codes.
//
// Writes a short summary of the change to stdout, and to the file in $DE_AREAS_SUMMARY when set (the PR body).
// Needs `unzip` and Node 22.18+. No dependencies.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BNETZA_PAGE =
  'https://www.bundesnetzagentur.de/DE/Fachthemen/Telekommunikation/Nummerierung/ONRufnr/Einteilung_ONB/artikel.html'
const OZRNB_URL =
  'https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/Telekommunikation/Nummerierung/ONRufnr/NVONB.INTERNET.OZRNB.zip'
const DESTATIS_URL = (quarter: number) =>
  `https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/Archiv/GVAuszugQ/AuszugGV${quarter}QAktuell.xlsx?__blob=publicationFile`
/** How much smaller a list may get against the current file before the update refuses (0.02: 2 % fewer lines). */
const MAX_DROP = { ortsnetze: 0.01, gemeinden: 0.03, blocks: 0.25 }

const DATA = new URL('../src/de-areas.data.ts', import.meta.url)
const GENERATOR = new URL('./de-areas.ts', import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'de-areas-'))

/** GET with three tries; the BNetzA's servers time out now and then. */
async function get(url: string, timeoutMs: number): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'linedesk-de-areas-update' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      const reason = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message
      if (attempt >= 3) throw new Error(`${url}: ${reason}`)
      console.warn(`${url}: ${reason}, trying again`)
      await new Promise(resolve => setTimeout(resolve, attempt * 10_000))
    }
  }
}

async function download(url: string, to: string): Promise<void> {
  // data.bundesnetzagentur.de can be slow (the block list is ~3 MB, the boundaries ~20 MB); a slow line needs the hour.
  const body = await get(url, 60 * 60_000)
  // Every file wanted is a zip (an xlsx is one too); an HTML error page with status 200 fails here.
  if (body.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') throw new Error(`${url}: not a zip file`)
  writeFileSync(to, body)
  console.log(`${url} (${(body.length / 1e6).toFixed(2)} MB)`)
}

/** Unzips into a folder of its own and returns the paths of every file in it whose name matches. */
function unzip(zip: string, pattern: RegExp): string[] {
  const dir = `${zip}.d`
  mkdirSync(dir)
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir])
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(path => pattern.test(path.split('/').at(-1)!))
    .map(path => join(dir, path))
}

function one<T>(found: T[], what: string): T {
  if (found.length !== 1) throw new Error(`expected exactly one ${what}, found ${found.length}: ${found.join(', ')}`)
  return found[0]!
}

/** Line counts of the lists in a de-areas.data.ts, and its D451 block areas, to compare before and after. */
function counts(source: string) {
  const list = (name: string) => {
    const m = new RegExp(`export const ${name} =\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(source)
    if (!m) throw new Error(`${name} not in de-areas.data.ts`)
    return m[1]!.split('\\n')
  }
  const blocks = list('DE_CARRIER_BLOCKS')
  return {
    ortsnetze: list('DE_ORTSNETZE').length,
    gemeinden: list('DE_GEMEINDEN').length,
    blocks: blocks.length,
    blockAreas: new Set(blocks.map(line => line.split('\\t')[1])).size,
    blockLines: new Set(blocks),
    sources: /^\/\/ Sources[\s\S]*?(?=\n\n)/m.exec(source)?.[0] ?? '',
  }
}

try {
  // BNetzA page: the Vorwahlverzeichnis zip and the boundaries zip.
  const page = (await get(BNETZA_PAGE, 60_000)).toString('utf8')
  const links = [...page.matchAll(/href="([^"]+)"/g)].map(m =>
    new URL(m[1]!.replace(/&amp;/g, '&'), BNETZA_PAGE).toString(),
  )
  const unique = (found: string[]) => [...new Set(found)]
  const vwvUrl = one(
    unique(links.filter(l => /\/Vorwahlverzeichnis_ONB[^/]*\.zip/i.test(l))),
    'Vorwahlverzeichnis link',
  )
  const boundariesUrl = one(unique(links.filter(l => /\/ONBGrenzen\/[^/]+\.zip$/i.test(l))), 'ONB-Grenzen link')
  const boundariesName = /_(\d{2})(\d{2})(\d{4})\.zip$/.exec(boundariesUrl)
  if (!boundariesName) throw new Error(`${boundariesUrl}: no edition date (_ddmmyyyy.zip) in the name`)
  const boundariesDate = `${boundariesName[3]}-${boundariesName[2]}-${boundariesName[1]}`

  const zips = {
    vwv: join(work, 'vwv.zip'),
    boundaries: join(work, 'boundaries.zip'),
    blocks: join(work, 'blocks.zip'),
  }
  await download(vwvUrl, zips.vwv)
  await download(boundariesUrl, zips.boundaries)
  await download(OZRNB_URL, zips.blocks)
  const csv = one(unzip(zips.vwv, /^NVONB\.INTERNET\.\d{8}\.ONB\.csv$/), 'NVONB.INTERNET.<date>.ONB.csv')
  const shp = one(unzip(zips.boundaries, /\.shp$/i), 'shapefile (.shp)')
  const blocks = one(unzip(zips.blocks, /^NVONB\.INTERNET\.\d{8}\.OZRNB\.csv$/), 'NVONB.INTERNET.<date>.OZRNB.csv')

  // Destatis: the quarter with the newest Gebietsstand.
  const editions: { path: string; date: string }[] = []
  for (const quarter of [1, 2, 3, 4]) {
    const path = join(work, `AuszugGV${quarter}QAktuell.xlsx`)
    await download(DESTATIS_URL(quarter), path)
    const workbook = execFileSync('unzip', ['-p', path, 'xl/workbook.xml']).toString('utf8')
    const name = one(
      unique([...workbook.matchAll(/<sheet [^>]*name="Onlineprodukt_Gemeinden(\d{2})(\d{2})(\d{4})"/g)].map(m => m[0])),
      `sheet Onlineprodukt_Gemeinden<ddmmyyyy> in AuszugGV${quarter}QAktuell.xlsx`,
    )
    const [, d, m, y] = /(\d{2})(\d{2})(\d{4})"$/.exec(name)!
    editions.push({ path, date: `${y}-${m}-${d}` })
  }
  const xlsx = editions.sort((a, b) => b.date.localeCompare(a.date))[0]!.path

  const before = readFileSync(DATA, 'utf8')
  execFileSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      GENERATOR.pathname,
      csv,
      shp,
      xlsx,
      blocks,
      `--boundaries-date=${boundariesDate}`,
    ],
    { stdio: 'inherit' },
  )
  const after = readFileSync(DATA, 'utf8')

  const old = counts(before)
  const now = counts(after)
  for (const key of ['ortsnetze', 'gemeinden', 'blocks'] as const) {
    if (now[key] < old[key] * (1 - MAX_DROP[key])) {
      writeFileSync(DATA, before)
      throw new Error(
        `${key}: ${now[key]} instead of ${old[key]}, more than ${MAX_DROP[key] * 100} % fewer. The file is left as it was; ` +
          'check the sources by hand (a changed format?) and run scripts/de-areas.ts with them.',
      )
    }
  }
  const added = [...now.blockLines].filter(line => !old.blockLines.has(line))
  const removed = [...old.blockLines].filter(line => !now.blockLines.has(line))
  const delta = (a: number, b: number) => (a === b ? `${b} (unchanged)` : `${b} (was ${a})`)
  const block = (line: string) => {
    // Lines of the string literal in the source, so the tab is still written as \t.
    const [carrier, onkz, digits] = line.split('\\t')
    return `${carrier} 0${onkz} ${digits}…`
  }
  const summary = [
    before === after ? 'No change: the data file already has these editions.' : 'German area data refreshed.',
    '',
    `- Ortsnetze: ${delta(old.ortsnetze, now.ortsnetze)}`,
    `- Municipalities: ${delta(old.gemeinden, now.gemeinden)}`,
    `- D451 blocks: ${delta(old.blocks, now.blocks)} in ${delta(old.blockAreas, now.blockAreas)} Ortsnetze`,
    ...(added.length ? [`- New blocks: ${added.map(block).join(', ')}`] : []),
    ...(removed.length ? [`- Blocks gone: ${removed.map(block).join(', ')}`] : []),
    '',
    'Sources:',
    '```',
    now.sources,
    '```',
  ].join('\n')
  console.log(`\n${summary}`)
  if (process.env.DE_AREAS_SUMMARY) writeFileSync(process.env.DE_AREAS_SUMMARY, `${summary}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
