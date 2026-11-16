import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type JournalEntry, journalErrors } from './check-journal.ts'

const entry = (idx: number, when: number, tag: string): JournalEntry => ({ idx, when, tag })
const files = (...tags: string[]) => tags.map(t => `${t}.sql`)

test('the repo journal is in order', () => {
  const dir = join(import.meta.dirname, '..', 'migrations')
  const { entries } = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'))
  assert.deepEqual(journalErrors(entries, readdirSync(dir).filter(f => f.endsWith('.sql'))), [])
})

test('in order, with a gap in the numbers (a migration of another branch not merged yet): fine', () => {
  assert.deepEqual(journalErrors([entry(0, 10, '0000_a'), entry(1, 20, '0002_c')], files('0000_a', '0002_c')), [])
})

test('a `when` not after the one before (two branches merged in the other order) is an error', () => {
  const errors = journalErrors([entry(0, 10, '0000_a'), entry(1, 30, '0001_b'), entry(2, 20, '0002_c')], files('0000_a', '0001_b', '0002_c'))
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /0002_c: when 20 is not after 0001_b's 30/)
  assert.match(journalErrors([entry(0, 10, '0000_a'), entry(1, 10, '0001_b')], files('0000_a', '0001_b'))[0]!, /not after/)
})

test('idx out of place, numbers out of order and files without an entry (or the other way round) are errors', () => {
  assert.match(journalErrors([entry(0, 10, '0000_a'), entry(2, 20, '0001_b')], files('0000_a', '0001_b'))[0]!, /idx 2, but it is entry 1/)
  assert.match(journalErrors([entry(0, 10, '0001_a'), entry(1, 20, '0001_b')], files('0001_a', '0001_b'))[0]!, /number is not after/)
  assert.deepEqual(journalErrors([entry(0, 10, '0000_a')], files('0000_a', '0001_b')), ['0001_b.sql: not in the journal'])
  assert.deepEqual(journalErrors([entry(0, 10, '0000_a')], []), ['0000_a: no 0000_a.sql'])
})
