import type { ActionItem, Call } from '@linedesk/db/types'
import { Fragment } from 'react'
import { useRun } from '../store.tsx'
import { Checkbox } from '../ui/controls.tsx'
import { cx } from '../ui/kit.tsx'
import { uniqueKeys } from '../ui/uniqueKeys.ts'
import { useT } from '@linedesk/i18n/react'

function NextSteps({ call }: { call: Call }) {
  const t = useT()
  const run = useRun()
  const toggle = (index: number) => {
    const items: ActionItem[] = call.action_items.map((item, i) =>
      i === index ? { text: item.text, done: !item.done } : item,
    )
    void run('call.setActionItems', { callId: call.id, items })
  }
  const keys = uniqueKeys(call.action_items.map(item => item.text))
  return (
    <div className="sum-todo">
      <span className="sum-label">{t('call.summary.nextSteps')}</span>
      {call.action_items.map((item, i) => (
        <Checkbox
          key={keys[i]}
          className={cx('sum-task', item.done && 'is-done')}
          checked={!!item.done}
          onChange={() => toggle(i)}
        >
          {item.text}
        </Checkbox>
      ))}
    </div>
  )
}

/** What the call was about: summary, key facts and next steps. */
export function SummaryCard({ call }: { call: Call }) {
  const t = useT()
  if (!call.summary && !call.fields.length && !call.action_items.length) return null
  const fieldKeys = uniqueKeys(call.fields.map(f => f.label))
  return (
    <section className="sumcard" aria-label={t('call.summary.title')}>
      <div className="sum-h">
        <b>{t('call.summary.title')}</b>
      </div>
      {call.summary && <p className="sum-text">{call.summary}</p>}
      {call.fields.length > 0 && (
        <div className="sum-grid">
          <div className="sum-col">
            <span className="sum-label">{t('call.summary.keyFacts')}</span>
            <dl className="facts">
              {call.fields.map((f, i) => (
                <Fragment key={fieldKeys[i]}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </div>
      )}
      {call.action_items.length > 0 && <NextSteps call={call} />}
    </section>
  )
}
