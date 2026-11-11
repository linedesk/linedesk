// Replaces the inbox header while calls are selected: what is selected and what can be done with it.
import { Button } from '../ui/kit.tsx'

export type BulkActions = {
  count: number
  /** In Done the main action brings calls back instead of finishing them. */
  inDone: boolean
  onDone: () => void
  onRemind: () => void
  onToggleRead: () => void
  /** The member picker under the Assign button; unset while the workspace has a single member. */
  onAssign?: (anchor: DOMRect) => void
  onDelete: () => void
  onCommands: () => void
  onClear: () => void
}

export function BulkBar(b: BulkActions) {
  return (
    <div className="ib-bulk" role="toolbar" aria-label="Selected calls">
      <b>{b.count} selected</b>
      {/* Narrow windows show the icons only (ib-bulk-label); Read / unread is then under ⋯. Select all is ⌘A. */}
      <span className="ib-bulk-acts">
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-label"
          icon={b.inDone ? 'restart' : 'check'}
          aria-label={b.inDone ? 'Not done' : 'Done'}
          title={b.inDone ? 'Mark not done (⇧E)' : 'Mark done (E)'}
          onClick={b.onDone}
        >
          {b.inDone ? 'Not done' : 'Done'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-label"
          icon="clock"
          aria-label="Remind"
          title="Remind me (H)"
          onClick={b.onRemind}
        >
          Remind
        </Button>
        {b.onAssign && (
          <Button
            size="sm"
            variant="ghost"
            className="ib-bulk-label"
            icon="user"
            aria-label="Assign"
            aria-haspopup="dialog"
            title="Assign (A)"
            onClick={e => b.onAssign!(e.currentTarget.getBoundingClientRect())}
          >
            Assign
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-wide"
          title="Mark read or unread (U)"
          onClick={b.onToggleRead}
        >
          Read / unread
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-label"
          icon="trash"
          aria-label="Delete"
          title="Delete (#)"
          onClick={b.onDelete}
        >
          Delete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="more"
          aria-label="All commands"
          title="All commands (⌘ K)"
          onClick={b.onCommands}
        />
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-clear"
          shortcut={['esc']}
          title="Clear selection (esc)"
          onClick={b.onClear}
        >
          Clear
        </Button>
      </span>
    </div>
  )
}
