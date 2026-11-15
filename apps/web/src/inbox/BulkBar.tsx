// Replaces the inbox header while calls are selected: what is selected and what can be done with it.
import { Button } from '../ui/kit.tsx'
import { useT } from '@linedesk/i18n/react'

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
  /** Every call in the current view (the list's select-all box, ⌘A). */
  onSelectAll: () => void
  onClear: () => void
}

export function BulkBar(b: BulkActions) {
  const t = useT()
  return (
    <div className="ib-bulk" role="toolbar" aria-label={t('inbox.bulk.label')}>
      <b>{t('inbox.bulk.selected', { count: b.count })}</b>
      {/* Narrow windows show the icons only (ib-bulk-label); Read / unread is then under ⋯. Select all is ⌘A. */}
      <span className="ib-bulk-acts">
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-label"
          icon={b.inDone ? 'restart' : 'check'}
          aria-label={b.inDone ? t('inbox.action.notDone') : t('inbox.action.done')}
          title={
            b.inDone
              ? t('common.withKeyHint', {
                  label: t('shell.command.markNotDone'),
                  key: '⇧E',
                  hint: t('inbox.action.notDoneHint'),
                })
              : t('common.withKey', { label: t('shell.command.markDone'), key: 'E' })
          }
          onClick={b.onDone}
        >
          {b.inDone ? t('inbox.action.notDone') : t('inbox.action.done')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-label"
          icon="clock"
          aria-label={t('inbox.action.remind')}
          title={t('common.withKey', { label: t('shell.command.remindMe'), key: 'H' })}
          onClick={b.onRemind}
        >
          {t('inbox.action.remind')}
        </Button>
        {b.onAssign && (
          <Button
            size="sm"
            variant="ghost"
            className="ib-bulk-label"
            icon="user"
            aria-label={t('inbox.assign.label')}
            aria-haspopup="dialog"
            title={t('common.withKey', { label: t('inbox.assign.label'), key: 'A' })}
            onClick={e => b.onAssign!(e.currentTarget.getBoundingClientRect())}
          >
            {t('inbox.assign.label')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-wide"
          title={t('common.withKey', { label: t('shell.help.row.markReadOrUnread'), key: 'U' })}
          onClick={b.onToggleRead}
        >
          {t('inbox.action.readUnread')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-label"
          icon="trash"
          aria-label={t('common.action.delete')}
          title={t('common.withKey', { label: t('common.action.delete'), key: '#' })}
          onClick={b.onDelete}
        >
          {t('common.action.delete')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="more"
          aria-label={t('inbox.action.allCommands')}
          title={t('common.withKey', { label: t('inbox.action.allCommands'), key: '⌘ K' })}
          onClick={b.onCommands}
        />
        <Button
          size="sm"
          variant="ghost"
          className="ib-bulk-clear"
          shortcut={['esc']}
          title={t('common.withKey', { label: t('shell.command.clearSelection'), key: 'esc' })}
          onClick={b.onClear}
        >
          {t('inbox.bulk.clear')}
        </Button>
      </span>
    </div>
  )
}
