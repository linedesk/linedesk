// Replaces the inbox header while calls are selected: what is selected and what can be done with it.
import { Button } from '../ui/kit.tsx'

export type BulkActions = {
  count: number
  /** In Done the main action brings calls back instead of finishing them. */
  inDone: boolean
  onDone: () => void
  onRemind: () => void
  onToggleRead: () => void
  onDelete: () => void
  onCommands: () => void
  onSelectAll: () => void
  onClear: () => void
}

export function BulkBar(b: BulkActions) {
  return (
    <div className="ib-bulk" role="toolbar" aria-label="Selected calls">
      <b>{b.count} selected</b>
      <Button size="sm" variant="ghost" title="Select all (⌘ A)" onClick={b.onSelectAll}>Select all</Button>
      <span className="ib-bulk-acts">
        <Button size="sm" variant="ghost" icon={b.inDone ? 'restart' : 'check'} title={b.inDone ? 'Mark not done (⇧E)' : 'Mark done (E)'} onClick={b.onDone}>{b.inDone ? 'Not done' : 'Done'}</Button>
        <Button size="sm" variant="ghost" icon="clock" title="Remind me (H)" onClick={b.onRemind}>Remind</Button>
        <Button size="sm" variant="ghost" title="Mark read or unread (U)" onClick={b.onToggleRead}>Read / unread</Button>
        <Button size="sm" variant="ghost" icon="trash" title="Delete (#)" onClick={b.onDelete}>Delete</Button>
        <Button size="sm" variant="ghost" icon="more" aria-label="All commands" title="All commands (⌘ K)" onClick={b.onCommands} />
        <Button size="sm" variant="ghost" shortcut={['esc']} title="Clear selection (esc)" onClick={b.onClear}>Clear</Button>
      </span>
    </div>
  )
}
