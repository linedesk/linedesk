import type { ReactNode } from 'react'
import type { InboxTab } from '../inbox-model.ts'
import { Kbd } from '../ui/kit.tsx'
import { ZeroState } from '../ui/listPage.tsx'
import { T } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

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
  const { t } = i18n()
  if (search) return { title: t('inbox.empty.search', { search }), line: null }
  if (!hasAnyCalls)
    return { title: t('inbox.empty.noCalls'), line: quiet ? null : t('inbox.empty.noCallsLine', { assistant }) }
  switch (tab) {
    case 'you':
      return {
        title: t('inbox.empty.you'),
        line:
          handledCount > 0 ? (
            <T
              k="inbox.empty.youResolved"
              values={{
                assistant,
                count: handledCount,
                b: chunks => <b>{chunks}</b>,
                key: <Kbd keys={['tab']} />,
              }}
            />
          ) : null,
      }
    case 'ai':
      return { title: t('inbox.empty.ai', { assistant }), line: t('inbox.empty.aiLine', { assistant }) }
    case 'spam':
      return { title: t('inbox.empty.spam'), line: t('inbox.empty.spamLine') }
    case 'done':
      return { title: t('inbox.empty.done'), line: t('inbox.empty.doneLine') }
    case 'reminders':
      return { title: t('inbox.empty.reminders'), line: t('inbox.empty.remindersLine') }
    case 'mine':
      return { title: t('inbox.empty.mine'), line: null }
    case 'member':
      return { title: t('inbox.empty.member'), line: null }
    case 'unassigned':
      return { title: t('inbox.empty.unassigned'), line: null }
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
