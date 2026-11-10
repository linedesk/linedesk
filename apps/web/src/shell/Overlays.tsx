import { reminderOptions, type ReminderOption } from '../inbox/remind.ts'
import { Backdrop } from '../ui/Backdrop.tsx'
import { CommandMenu, type CommandGroup, type SelectVia } from '../ui/CommandMenu.tsx'
import type { Command } from './commands.ts'
import { HelpSheet } from './HelpSheet.tsx'
import type { Overlay } from './keys.ts'

type Props = {
  overlay: Overlay
  commands: CommandGroup<Command>[]
  onClose: () => void
  onCommand: (command: Command, via: SelectVia) => void
  onReminder: (option: ReminderOption) => void
}

/** What floats above the app: ⌘K, the remind menu and the shortcut sheet. */
export function Overlays({ overlay, commands, onClose, onCommand, onReminder }: Props) {
  if (!overlay) return null
  return (
    <Backdrop onClose={onClose}>
      {overlay === 'commands' && <CommandMenu groups={commands} onSelect={onCommand} />}
      {overlay === 'remind' && <CommandMenu numbered placeholder="Remind me …" groups={[{ label: 'Bring this call back', items: reminderOptions() }]} onSelect={onReminder} />}
      {overlay === 'help' && <HelpSheet />}
    </Backdrop>
  )
}
