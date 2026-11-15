import type { CSSProperties } from 'react'
import { reminderOptions, type ReminderOption, typedReminder } from '../inbox/remind.ts'
import { Backdrop } from '../ui/Backdrop.tsx'
import { CommandMenu, type CommandGroup, type SelectVia } from '../ui/CommandMenu.tsx'
import type { Command } from './commands.ts'
import { HelpSheet } from './HelpSheet.tsx'
import type { Overlay } from './keys.ts'
import { useT } from '@linedesk/i18n/react'

/**
 * A pick list (the member picker): its name, the field's placeholder and what it offers. `anchor`: the
 * button it was opened from; the list then opens under it instead of in the middle of the window.
 */
export type Picker = { label: string; placeholder: string; groups: CommandGroup<Command>[]; anchor?: DOMRect }

const PICKER_WIDTH = 300
const GAP = 4

/** Under the button, its right edges lined up with it, kept inside the window. */
export function anchoredStyle(anchor: DOMRect, width = PICKER_WIDTH): CSSProperties {
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))
  return { position: 'fixed', top: anchor.bottom + GAP, left, width }
}

type Props = {
  overlay: Overlay
  commands: CommandGroup<Command>[]
  picker: Picker | null
  onClose: () => void
  onCommand: (command: Command, via: SelectVia) => void
  onReminder: (option: ReminderOption) => void
}

/** What floats above the app: ⌘K, the remind menu, the member picker and the shortcut sheet. */
export function Overlays({ overlay, commands, picker, onClose, onCommand, onReminder }: Props) {
  const t = useT()
  if (!overlay) return null
  const anchor = overlay === 'pick' ? picker?.anchor : undefined
  if (anchor && picker)
    return (
      <Backdrop onClose={onClose} anchored>
        <div className="k-cmd-anchored" style={anchoredStyle(anchor)}>
          <CommandMenu
            numbered
            label={picker.label}
            placeholder={picker.placeholder}
            groups={picker.groups}
            onSelect={onCommand}
          />
        </div>
      </Backdrop>
    )
  return (
    <Backdrop onClose={onClose}>
      {overlay === 'commands' && <CommandMenu groups={commands} onSelect={onCommand} />}
      {overlay === 'remind' && (
        <CommandMenu
          numbered
          label={t('inbox.remind.title')}
          placeholder={t('inbox.remind.placeholder')}
          groups={[{ label: t('inbox.remind.group'), items: reminderOptions() }]}
          fromQuery={query => {
            const typed = typedReminder(query)
            return typed && { label: t('inbox.remind.typed'), items: [typed] }
          }}
          onSelect={onReminder}
        />
      )}
      {overlay === 'pick' && picker && (
        <CommandMenu
          numbered
          label={picker.label}
          placeholder={picker.placeholder}
          groups={picker.groups}
          onSelect={onCommand}
        />
      )}
      {overlay === 'help' && <HelpSheet />}
    </Backdrop>
  )
}
