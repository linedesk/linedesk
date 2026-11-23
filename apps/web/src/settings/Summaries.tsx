// The summary cards on top of Assistant › Hours & holidays, Rules and Transfers (LIN-392, LIN-443). The sentences come
// from summaryModel.ts; these read the page's state (workspace settings, the assistant's draft) and show them.
import { useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { appLink } from '../ui/AppLink.tsx'
import type { IconName } from '../ui/icons.ts'
import { Sentence, SummaryCard } from '../ui/SummaryCard.tsx'
import type { Draft, TransferDraft } from './assistantDraft.ts'
import { useBusinessHours } from './BusinessHours.tsx'
import { closureState, upcomingDays } from './closedDaysModel.ts'
import { useClosedDays } from './Holidays.tsx'
import { hoursSummary, rulesSummary, type Summary, transfersSummary } from './summaryModel.ts'
import { useContactWho } from './transferOwner.ts'

type Tags = Record<string, (chunks: ReactNode[]) => ReactNode>

/** A Summary in a SummaryCard: its sentences in one paragraph, and what needs the owner after a red badge. */
export function SummaryView({ summary, icon, tags }: { summary: Summary; icon: IconName; tags?: Tags }) {
  const t = useT()
  const { sentences, needsYou } = summary
  return (
    <SummaryCard
      icon={icon}
      label={t('settings.summary.label')}
      needsYou={
        needsYou && { badge: t('settings.summary.needsYou'), text: <Sentence sentence={needsYou} tags={tags} /> }
      }
    >
      {sentences.map((sentence, i) => (
        <span key={sentence.k}>
          {i > 0 && ' '}
          <Sentence sentence={sentence} tags={tags} />
        </span>
      ))}
    </SummaryCard>
  )
}

/** Hours & holidays: when you are open, the next closed day, vacation mode. */
export function HoursSummary({
  assistantId,
  name,
  outsideGreeting,
}: {
  assistantId: string
  name: string
  outsideGreeting: boolean
}) {
  const hours = useBusinessHours()
  const { loaded, today, own, derived, calendar, closure } = useClosedDays()
  if (!hours.saved || !loaded) return null
  const summary = hoursSummary({
    name,
    on: hours.on,
    days: hours.days,
    upcoming: upcomingDays(own, derived, calendar, today),
    closure,
    today,
    outsideGreeting,
  })
  return <SummaryView summary={summary} icon="clock" tags={{ link: appLink(`#assistant/${assistantId}/general`) }} />
}

/** Transfers: who calls are put through to, and what happens when nobody fits. From the draft: it changes as you type. */
export function TransfersSummary({
  name,
  transfers,
  hoursOn,
}: {
  name: string
  transfers: readonly TransferDraft[]
  hoursOn: boolean
}) {
  const { today, closure } = useClosedDays()
  const vacationOn = !!closure && closureState(closure, today) === 'on'
  const who = useContactWho()
  return <SummaryView summary={transfersSummary({ name, transfers, hoursOn, vacationOn, who })} icon="phone-out" />
}

/** Rules: the tone, when the assistant says it is an AI, and the switches that are on. From the draft. */
export function RulesSummary({
  name,
  draft,
}: {
  name: string
  draft: Pick<Draft, 'communication_style' | 'ai_disclosure' | 'behaviours'>
}) {
  const summary = rulesSummary({
    name,
    style: draft.communication_style,
    disclosure: draft.ai_disclosure,
    behaviours: draft.behaviours,
  })
  return <SummaryView summary={summary} icon="checks" />
}
