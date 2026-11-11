// Several calls picked at once (checkbox, X, ⇧J/⇧K, ⌘A). Actions then apply to all of them.
import type { Call } from '@linedesk/db/types'
import { useCallback, useMemo, useState } from 'react'

/** Ids from `from` to `to` (both included) in list order; empty when either is not in the list. */
export function rangeIds(list: Call[], from: string, to: string): string[] {
  const a = list.findIndex(c => c.id === from)
  const b = list.findIndex(c => c.id === to)
  if (a < 0 || b < 0) return []
  return list.slice(Math.min(a, b), Math.max(a, b) + 1).map(c => c.id)
}

export function useSelection(list: Call[]) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  // Only calls still in the current view count: a call that left the view drops out of the selection.
  const calls = useMemo(() => list.filter(c => ids.has(c.id)), [list, ids])

  const toggle = useCallback((id: string) => {
    setIds(prev => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
    setAnchor(id)
  }, [])

  /** Shift-click: select everything between the last picked call and this one. */
  const range = useCallback((id: string) => {
    const span = anchor ? rangeIds(list, anchor, id) : [id]
    setIds(prev => new Set([...prev, ...span]))
    setAnchor(id)
  }, [anchor, list])

  const add = useCallback((...more: string[]) => setIds(prev => new Set([...prev, ...more])), [])
  const all = useCallback(() => setIds(new Set(list.map(c => c.id))), [list])
  const clear = useCallback(() => { setIds(new Set()); setAnchor(null) }, [])

  return { ids, calls, count: calls.length, toggle, range, add, all, clear }
}
export type Selection = ReturnType<typeof useSelection>
