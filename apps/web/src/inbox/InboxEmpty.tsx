import type { ReactNode } from 'react'
import type { InboxTab } from '../inbox-model.ts'
import { useRows } from '../store.tsx'
import { appLink } from '../ui/AppLink.tsx'
import { Kbd } from '../ui/kit.tsx'
import { ZeroState, type ZeroMark } from '../ui/listPage.tsx'
import { T } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'
import { CONNECT_NUMBER } from './goLive.ts'
import { useGoLiveVisible } from './GoLiveChecklist.tsx'

/**
 * The one next step of an inbox that never had a call, while no number is connected: `connect` (a link to Workspace
 * settings › Phone numbers) while the go-live checklist is on screen. Otherwise the setup line above the inbox
 * (SetupBanner) already says it, by role ("Connect your number" or "An owner or admin needs to connect one").
 */
export type NoCallsStep = 'connect' | null

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
  setup?: NoCallsStep
}

/**
 * The words of the empty state, per view: a title, at most one line under it and the picture's mark. The check means
 * "all caught up", so only views of an inbox that had calls get it; without any call yet it is the phone, with the
 * one next step as its line.
 */
export function emptyCopy({
  tab,
  search,
  assistant,
  handledCount,
  hasAnyCalls,
  quiet,
  setup = null,
}: InboxEmptyProps): {
  title: string
  line: ReactNode
  mark?: ZeroMark
} {
  const { t } = i18n()
  if (search) return { title: t('inbox.empty.search', { search }), line: null }
  if (!hasAnyCalls) {
    const line =
      setup === 'connect' ? (
        <T k="inbox.empty.connectNumber" values={{ assistant, link: appLink(CONNECT_NUMBER) }} />
      ) : quiet ? null : (
        t('inbox.empty.noCallsLine', { assistant })
      )
    return { title: t('inbox.empty.noCalls'), line, mark: 'phone' }
  }
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
export function InboxEmptyState(props: InboxEmptyProps) {
  const { title, line, mark } = emptyCopy(props)
  return <ZeroState title={title} line={line} mark={mark} />
}

/** InboxEmptyState with the next step for a workspace without calls and without a number (NoCallsStep). */
export function InboxEmpty(props: Omit<InboxEmptyProps, 'setup'>) {
  const hasNumber = useRows('phone_numbers').length > 0
  const checklist = useGoLiveVisible()
  return <InboxEmptyState {...props} setup={!hasNumber && checklist ? 'connect' : null} />
}
