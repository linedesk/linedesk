/**
 * `pnpm db:check-journal`: the migrations journal (migrations/meta/_journal.json) is in order. Runs in CI on every pull
 * request (job `checks` in ci.yml); no database needed.
 *
 * The migrator applies a migration only when its `when` is later than the last applied one's (drizzle-orm, pg-core
 * dialect `migrate`). A journal entry whose `when` is not later than the one before it is skipped on every install
 * that is already past it, silently: its tables or columns never exist there. That happens when two branches each
 * generate a migration and are merged in the other order. So:
 * - `idx` is the entry's place (0, 1, 2, …) and `when` strictly increases;
 * - the tags' numbers strictly increase;
 * - every .sql file in migrations/ has an entry, and every entry its .sql file.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type JournalEntry = { idx: number; when: number; tag: string }

/** What is wrong with the journal (empty: nothing). `files`: the .sql files in the migrations folder. */
export function journalErrors(entries: readonly JournalEntry[], files: readonly string[]): string[] {
  const errors: string[] = []
  entries.forEach((entry, i) => {
    if (entry.idx !== i) errors.push(`${entry.tag}: idx ${entry.idx}, but it is entry ${i}`)
    const before = entries[i - 1]
    if (!before) return
    if (!(entry.when > before.when))
      errors.push(`${entry.tag}: when ${entry.when} is not after ${before.tag}'s ${before.when}: installs past ${before.tag} would skip it (regenerate it)`)
    const number = Number.parseInt(entry.tag, 10)
    if (!(number > Number.parseInt(before.tag, 10))) errors.push(`${entry.tag}: its number is not after ${before.tag}'s`)
  })
  const tags = new Set(entries.map(e => e.tag))
  for (const file of files) if (!tags.has(file.replace(/\.sql$/, ''))) errors.push(`${file}: not in the journal`)
  const sql = new Set(files)
  for (const entry of entries) if (!sql.has(`${entry.tag}.sql`)) errors.push(`${entry.tag}: no ${entry.tag}.sql`)
  return errors
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(import.meta.dirname, '..', 'migrations')
  const { entries } = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }
  const errors = journalErrors(entries, readdirSync(dir).filter(f => f.endsWith('.sql')))
  for (const error of errors) console.error(`migrations journal: ${error}`)
  if (errors.length) process.exit(1)
  console.log(`migrations journal: ${entries.length} entries in order`)
}
