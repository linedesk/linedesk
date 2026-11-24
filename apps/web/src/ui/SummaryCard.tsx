// The summary card at the top of a settings page: an icon and what the page's settings do, in one or two plain
// sentences with the key facts in bold, plus a red "needs you" line when something is broken. Booking & calendar,
// Hours & holidays, Transfers and Notifications start with one (LIN-355, LIN-392). It reads the same local state
// as the page below it, so it changes with every edit.
import type { MessageKey } from '@linedesk/i18n'
import { T } from '@linedesk/i18n/react'
import { Fragment, type ReactNode } from 'react'
import { intlLocale } from '../i18n/format.ts'
import type { IconName } from './icons.ts'
import { Badge, Icon } from './kit.tsx'
import './summary-card.css'

/** "A, B and C" in the active language, each name in bold. */
export function boldList(names: readonly string[]): ReactNode {
  // Keyed by where each part starts in the sentence: unique, and the same on every render.
  let at = 0
  return new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).formatToParts(names).map(part => {
    const key = `${at}`
    at += part.value.length
    return part.type === 'element' ? <b key={key}>{part.value}</b> : <Fragment key={key}>{part.value}</Fragment>
  })
}

/** The `<b>` tag of a message: its words in bold. */
export const bold = (chunks: ReactNode[]) => <b>{chunks}</b>

/**
 * One sentence of a summary as data, so a model without React can build it (and a test can read it): a message
 * key and its values. A list of names becomes "A, B and C" in bold; `<b>` in the message is bold.
 */
export type SummarySentence = {
  k: MessageKey
  values?: Record<string, string | number | readonly string[]>
}

/** A SummarySentence as text; `tags` adds renderers for other tags of the message (a link). */
export function Sentence({
  sentence,
  tags,
}: {
  sentence: SummarySentence
  tags?: Record<string, (chunks: ReactNode[]) => ReactNode>
}) {
  const values: Record<string, ReactNode | ((chunks: ReactNode[]) => ReactNode)> = { b: bold, ...tags }
  for (const [name, value] of Object.entries(sentence.values ?? {}))
    values[name] = Array.isArray(value) ? boldList(value as readonly string[]) : (value as string | number)
  return <T k={sentence.k} values={values} />
}

type Props = {
  icon: IconName
  /** The card's name for screen readers. */
  label: string
  /** The sentences. */
  children: ReactNode
  /** Something to fix, after a red badge (`badge`: its words). */
  needsYou?: { badge: string; text: ReactNode } | null
}

export function SummaryCard({ icon, label, children, needsYou }: Props) {
  return (
    <section className="summary-card" aria-label={label}>
      <span className="summary-card-mark" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <div className="summary-card-text">
        <p>{children}</p>
        {needsYou && (
          <p className="summary-card-warn">
            <Badge tone="danger">{needsYou.badge}</Badge>
            <span>{needsYou.text}</span>
          </p>
        )}
      </div>
    </section>
  )
}
