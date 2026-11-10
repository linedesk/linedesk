import type { ActionItem, Call } from '@callfront/db/types'
import { Fragment } from 'react'
import { useRun } from '../store.tsx'

function NextSteps({ call }: { call: Call }) {
  const run = useRun()
  const toggle = (index: number) => {
    const items: ActionItem[] = call.action_items.map((item, i) => (i === index ? { text: item.text, done: !item.done } : item))
    void run('call.setActionItems', { callId: call.id, items })
  }
  return (
    <div className="sum-todo">
      <span className="sum-label">Next steps</span>
      {call.action_items.map((item, i) => (
        <label key={item.text} className="sum-task">
          <input type="checkbox" checked={!!item.done} onChange={() => toggle(i)} />
          <span>{item.text}</span>
        </label>
      ))}
    </div>
  )
}

/** What the call was about: summary, key facts and next steps. */
export function SummaryCard({ call }: { call: Call }) {
  if (!call.summary && !call.fields.length && !call.action_items.length) return null
  return (
    <section className="sumcard" aria-label="Summary">
      <div className="sum-h"><b>Summary</b></div>
      {call.summary && <p className="sum-text">{call.summary}</p>}
      {call.fields.length > 0 && (
        <div className="sum-grid">
          <div className="sum-col">
            <span className="sum-label">Key facts</span>
            <dl className="facts">{call.fields.map(f => <Fragment key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></Fragment>)}</dl>
          </div>
        </div>
      )}
      {call.action_items.length > 0 && <NextSteps call={call} />}
    </section>
  )
}
