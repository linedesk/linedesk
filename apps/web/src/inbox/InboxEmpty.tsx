import type { ReactNode } from 'react'
import type { InboxTab } from '../inbox-model.ts'
import { Kbd } from '../ui/kit.tsx'
import { ZeroState } from '../ui/listPage.tsx'

export type InboxEmptyProps = {
  tab: InboxTab
  search: string | null
  assistant: string
  /** Calls in Handled by <assistant>: Needs you says how many the assistant resolved. */
  handledCount: number
  /** Any call in any view: without one, every view says that no call came in yet. */
  hasAnyCalls: boolean
  /** The first-call line above the list already says what happens when a call comes in. */
  quiet?: boolean
}

/** The words of the empty state: a title and at most one line under it, per view. */
export function emptyCopy({ tab, search, assistant, handledCount, hasAnyCalls, quiet }: InboxEmptyProps): {
  title: string
  line: ReactNode
} {
  if (search) return { title: `No call mentions “${search}”`, line: null }
  if (!hasAnyCalls) return { title: 'No calls yet', line: quiet ? null : `Calls ${assistant} answers show up here.` }
  switch (tab) {
    case 'you':
      return {
        title: 'Nothing needs you right now',
        line:
          handledCount > 0 ? (
            <>
              {assistant} resolved <b>{handledCount}</b> {handledCount === 1 ? 'call' : 'calls'} on its own. Press{' '}
              <Kbd keys={['tab']} /> to see {handledCount === 1 ? 'it' : 'them'}.
            </>
          ) : null,
      }
    case 'ai':
      return {
        title: `Nothing handled by ${assistant} right now`,
        line: `Calls ${assistant} resolves on its own show up here.`,
      }
    case 'spam':
      return { title: 'No spam right now', line: 'Blocked sales calls and robocalls show up here.' }
    case 'done':
      return { title: 'Nothing done yet', line: 'Calls you mark done show up here.' }
    case 'reminders':
      return { title: 'No reminders', line: "Calls you set a reminder on wait here until it's time." }
    case 'mine':
      return { title: 'Nothing assigned to you', line: null }
    case 'member':
      return { title: 'Nothing assigned to them', line: null }
    case 'unassigned':
      return { title: 'Every call that needs someone has someone', line: null }
  }
}

/**
 * The one empty state of every inbox view and of search: the same picture, in the same place (the middle
 * of the list, below the column headings), with the view's own words.
 */
export function InboxEmpty(props: InboxEmptyProps) {
  const { title, line } = emptyCopy(props)
  return <ZeroState title={title} line={line} />
}
