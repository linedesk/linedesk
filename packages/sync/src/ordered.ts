// A batch of row changes, applied in the order the server sent them. A row that leaves a shape
// and re-enters it in one batch (delete, then insert) must end up present, so upserts and
// removals are never regrouped across each other.
export type RowChange<R> = { op: 'upsert'; row: R } | { op: 'remove'; id: string }
export type ChangeRun<R> = { op: 'upsert'; rows: R[] } | { op: 'remove'; ids: string[] }

/** Consecutive changes of the same kind become one run; the order between runs is kept. */
export function inOrder<R>(changes: RowChange<R>[]): ChangeRun<R>[] {
  const runs: ChangeRun<R>[] = []
  for (const change of changes) {
    const last = runs.at(-1)
    if (change.op === 'upsert') {
      if (last?.op === 'upsert') last.rows.push(change.row)
      else runs.push({ op: 'upsert', rows: [change.row] })
    } else if (last?.op === 'remove') last.ids.push(change.id)
    else runs.push({ op: 'remove', ids: [change.id] })
  }
  return runs
}
