// The shortcut line under the inbox list: the row keys only while the view has a call to act on, the view and app
// keys always (an empty view still switches with Tab).
import { type MessageKey, msg } from '@linedesk/i18n'
import type { InboxTab } from '../inbox-model.ts'

export type Hint = [keys: string[], label: MessageKey]

export function inboxHints(tab: InboxTab, hasRows: boolean): Hint[] {
  const done: Hint =
    tab === 'done' ? [['⇧', 'E'], msg('common.shortcut.notDone')] : [['E'], msg('common.shortcut.done')]
  const rows: Hint[] = hasRows ? [[['⏎'], msg('common.shortcut.open')], done] : []
  return [
    ...rows,
    [['tab'], msg('common.shortcut.switch')],
    [['⌘', 'K'], msg('common.shortcut.commands')],
    [['?'], msg('common.shortcut.allShortcuts')],
  ]
}
