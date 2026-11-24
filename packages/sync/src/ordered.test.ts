import { describe, expect, it } from 'vitest'
import { inOrder } from './ordered.ts'

describe('change order', () => {
  it('keeps a row that is deleted and then re-inserted in one batch', () => {
    const runs = inOrder([{ op: 'remove', id: 'c1' }, { op: 'upsert', row: { id: 'c1', version: 9 } }])
    expect(runs).toEqual([{ op: 'remove', ids: ['c1'] }, { op: 'upsert', rows: [{ id: 'c1', version: 9 }] }])
    const present = new Map<string, unknown>([['c1', { id: 'c1', version: 7 }]])
    for (const run of runs) {
      if (run.op === 'remove') for (const id of run.ids) present.delete(id)
      else for (const row of run.rows) present.set(row.id, row)
    }
    expect(present.get('c1')).toEqual({ id: 'c1', version: 9 })
  })
  it('groups neighbours of the same kind and never reorders across kinds', () => {
    const row = (id: string) => ({ id })
    expect(inOrder([
      { op: 'upsert', row: row('a') }, { op: 'upsert', row: row('b') }, { op: 'remove', id: 'a' }, { op: 'remove', id: 'c' }, { op: 'upsert', row: row('d') },
    ])).toEqual([{ op: 'upsert', rows: [row('a'), row('b')] }, { op: 'remove', ids: ['a', 'c'] }, { op: 'upsert', rows: [row('d')] }])
    expect(inOrder([])).toEqual([])
  })
})
