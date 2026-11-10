import type { Call } from '@callfront/db/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveCursor } from '../inbox-model.ts'

/** The selected row. It follows its call when sync adds, removes or reorders rows. */
export function useCursor(list: Call[]) {
  const [cursorId, setCursor] = useState<string | null>(null)
  const previousIds = useRef<string[]>([])
  const ids = useMemo(() => list.map(c => c.id), [list])
  const cursor = resolveCursor(ids, cursorId, previousIds.current)
  useEffect(() => {
    previousIds.current = ids
    if (cursor !== cursorId) setCursor(cursor) // pin the resolved row, so a new first row does not take the cursor
  }, [ids, cursor, cursorId])
  return [cursor, setCursor] as const
}
