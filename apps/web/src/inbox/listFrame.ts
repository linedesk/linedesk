// What frames the calls of an inbox view: the first-call line above them and the column headings with the
// select-all box. The same in every view (Needs you, Handled, Spam, Reminders, Done, the assignee views):
// it depends on the search, the load state and whether there are calls, never on which view is open.
import type { LoadState } from '../ui/LoadStates.tsx'

export type ListFrameInput = {
  search: string | null
  loadState: LoadState
  /** Calls listed in the view. */
  count: number
  /** The first-call line's text, null once a real call came in. */
  firstCallHint: string | null | undefined
  /** The rows can be selected (a select-all box in the headings). */
  selectable: boolean
}

export function listFrame({ search, loadState, count, firstCallHint, selectable }: ListFrameInput) {
  const ready = loadState === 'ready'
  return {
    /** Until the first real call: one line above the calls of every view (not in search, which lists them all). */
    firstCallLine: Boolean(firstCallHint) && search === null && ready,
    /** Column headings stay while the view is empty; only before the first sync the skeleton stands alone. */
    columnHeads: selectable && (count > 0 || ready),
    /** Nothing in the view (once synced): the shared empty state below the headings. */
    empty: count === 0 && ready,
  }
}
