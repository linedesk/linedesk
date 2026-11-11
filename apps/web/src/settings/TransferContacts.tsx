// Settings > Assistant > Transfers: the people the assistant puts callers through to (warm transfer),
// each with a plain-language condition, in order. One compact row per contact; a row opens in place to
// edit it (Done closes it). Part of the assistant's draft: saved with the page's Save. A field's error
// shows once the field was left or a save was tried, never on a row just added.
import { EMERGENCY_CONDITION, RING_SECONDS_MAX, RING_SECONDS_MIN } from '@linedesk/actions'
import type { TransferFallback } from '@linedesk/db/types'
import { useRef, useState } from 'react'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Input, Textarea } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import {
  canAddTransfer,
  moveTransfer,
  newTransferContact,
  type TransferDraft,
  type TransferProblem,
  transferInactive,
  transferProblem,
} from './assistantDraft.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { Field, Section } from './fields.tsx'

const fallbackOptions: SelectOption<TransferFallback>[] = [
  { value: 'message_urgent', label: 'Take a message, mark it urgent' },
  { value: 'message', label: 'Take a message' },
  { value: 'next', label: 'Try the next contact that fits' },
]
const fallbackShort: Record<TransferFallback, string> = {
  message_urgent: 'then an urgent message',
  message: 'then a message',
  next: 'then the next contact',
}
const ringOptions: SelectOption<string>[] = [10, 15, 20, 25, 30, 45, 60]
  .filter(s => s >= RING_SECONDS_MIN && s <= RING_SECONDS_MAX)
  .map(s => ({ value: String(s), label: `${s} seconds` }))

/** The id of a contact's field, for the label and for putting the cursor there after a failed save. */
export const transferFieldId = (index: number, field: TransferProblem['field']) => `tc-${index}-${field}`

type Props = {
  transfers: TransferDraft[]
  onChange: (transfers: TransferDraft[]) => void
  /** The workspace uses business hours: "only during business hours" can apply. */
  hoursOn: boolean
  assistantName: string
  /** A save was refused: every problem shows, and the row with the first one opens. */
  showErrors?: boolean
}

/** Condition examples under an empty condition; the emergency one also makes the fallback an urgent message. */
const EXAMPLES: { label: string; patch: Partial<TransferDraft> }[] = [
  { label: 'Asks for a person', patch: { condition: 'The caller asks to speak to a person' } },
  { label: 'Emergency', patch: { condition: EMERGENCY_CONDITION, if_no_answer: 'message_urgent', hours_only: false } },
  { label: 'Billing questions', patch: { condition: 'Billing questions' } },
]

export function TransferContacts({ transfers, onChange, hoursOn, assistantName, showErrors = false }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  /** Fields left at least once, as `<contact id>:<field>`: their errors show. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const problem = transferProblem({ transfers })
  const update = (index: number, patch: Partial<TransferDraft>) =>
    onChange(transfers.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  function add() {
    const contact = newTransferContact(transfers, 'blank')
    onChange([...transfers, contact])
    setOpen(contact.id)
    setTimeout(() => document.getElementById(transferFieldId(transfers.length, 'name'))?.focus(), 0)
  }
  return (
    <Section
      id="as-transfer"
      title="Transfers"
      description="Who callers are put through to, and when. When several fit, they are tried from the top."
      help={`${assistantName} calls the contact first and tells whoever answers who is calling and why. If they press 1 or say yes, ${assistantName} connects the caller; that conversation isn't recorded. If no one picks up in time or they decline, ${assistantName} does what the contact says: take a message (urgent or not) or try the next contact that fits. ${assistantName} always tells the caller what is happening.`}
    >
      {transfers.length ? (
        <ol className="tc-list">
          {transfers.map((c, i) => {
            const mine = problem?.index === i ? problem : null
            const shown = mine && (showErrors || touched.has(`${c.id}:${mine.field}`)) ? mine : null
            return (
              <ContactRow
                key={c.id}
                contact={c}
                index={i}
                count={transfers.length}
                open={open === c.id || (showErrors && !!mine)}
                problem={shown}
                hoursOn={hoursOn}
                onToggle={() => setOpen(open === c.id ? null : c.id)}
                onClose={() => setOpen(null)}
                onLeave={field => setTouched(t => new Set(t).add(`${c.id}:${field}`))}
                onChange={patch => update(i, patch)}
                onMove={by => onChange(moveTransfer(transfers, i, by))}
                onRemove={() => onChange(transfers.filter((_, j) => j !== i))}
              />
            )
          })}
        </ol>
      ) : (
        <p className="tc-empty">No transfer contacts: {assistantName} takes a message on every call.</p>
      )}
      <div className="tc-add">
        <Button size="sm" icon="plus" disabled={!canAddTransfer({ transfers })} onClick={add}>
          Add contact
        </Button>
      </div>
    </Section>
  )
}

type RowProps = {
  contact: TransferDraft
  index: number
  count: number
  open: boolean
  /** The problem to show in this row (null: none, or not shown yet). */
  problem: TransferProblem | null
  hoursOn: boolean
  onToggle: () => void
  onClose: () => void
  onLeave: (field: TransferProblem['field']) => void
  onChange: (patch: Partial<TransferDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}

/** The muted line under a contact's name: ring time, fallback, hours. */
function summaryOf(c: TransferDraft, hoursOn: boolean): string {
  return [`Rings ${c.ring_seconds} s`, fallbackShort[c.if_no_answer], hoursOn && c.hours_only ? 'business hours only' : null]
    .filter(Boolean)
    .join(', ')
}

/** Grows the condition box with its text, from two lines up to the CSS max-height. */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}

function ContactRow(props: RowProps) {
  const { contact: c, index, count, open, problem, hoursOn, onToggle, onClose, onLeave, onChange, onMove, onRemove } = props
  const inactive = transferInactive(c)
  const name = c.name.trim() || 'New contact'
  const id = (field: TransferProblem['field']) => transferFieldId(index, field)
  const error = (field: TransferProblem['field']) => (problem?.field === field ? problem.message : null)
  const condition = useRef<HTMLTextAreaElement>(null)
  return (
    <li className={cx('tc-row', inactive && 'is-off', open && 'is-open')}>
      <div className="tc-line">
        <span className="tc-order" aria-hidden>
          {index + 1}
        </span>
        <button type="button" className="tc-main" onClick={onToggle} aria-expanded={open} title={open ? 'Close' : 'Edit'}>
          <span className="tc-title">
            <b>{name}</b>
            <span className="tc-number">{c.number.trim() || 'No number'}</span>
            {inactive && <span className="tc-status">{inactive}</span>}
          </span>
          <span className="tc-cond">{c.condition.trim() || 'No condition yet'}</span>
          <span className="tc-meta">{summaryOf(c, hoursOn)}</span>
        </button>
        <span className="tc-actions">
          <Button size="sm" variant="ghost" icon="up" title="Move up" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(-1)} />
          <Button size="sm" variant="ghost" icon="down" title="Move down" aria-label={`Move ${name} down`} disabled={index === count - 1} onClick={() => onMove(1)} />
          <Button size="sm" variant="ghost" icon="trash" title="Remove" aria-label={`Remove ${name}`} onClick={onRemove} />
          <Switch on={c.enabled} onChange={on => onChange({ enabled: on })} label={`Transfer to ${name}`} />
        </span>
      </div>
      {open && (
        <div className="tc-edit">
          <div className="tc-grid tc-grid-who">
            <Field id={id('name')} label="Name" error={error('name')}>
              <Input
                id={id('name')}
                value={c.name}
                onChange={e => onChange({ name: e.target.value })}
                onBlur={() => onLeave('name')}
                placeholder="Mike (on-call)"
                invalid={!!error('name')}
              />
            </Field>
            <Field id={id('number')} label="Phone number" error={error('number')} tip="A US mobile or landline: the person's own phone, not a Linedesk number.">
              <Input
                id={id('number')}
                value={c.number}
                onChange={e => onChange({ number: e.target.value })}
                onBlur={() => onLeave('number')}
                placeholder="+1 503 555 0100"
                inputMode="tel"
                invalid={!!error('number')}
              />
            </Field>
          </div>
          <Field id={id('condition')} label="When to put the caller through" error={error('condition')}>
            <Textarea
              id={id('condition')}
              ref={el => {
                condition.current = el
                grow(el)
              }}
              className="tc-cond-input"
              rows={2}
              value={c.condition}
              onChange={e => {
                onChange({ condition: e.target.value })
                grow(e.target)
              }}
              onBlur={() => onLeave('condition')}
              placeholder="In plain words, e.g. the caller asks for a person, or billing questions"
              invalid={!!error('condition')}
            />
            {!c.condition.trim() && (
              <span className="tc-examples">
                Examples:
                {EXAMPLES.map(example => (
                  <button
                    key={example.label}
                    type="button"
                    className="tc-example"
                    onClick={() => {
                      onChange(example.patch)
                      setTimeout(() => condition.current?.focus(), 0)
                    }}
                  >
                    {example.label}
                  </button>
                ))}
              </span>
            )}
          </Field>
          <div className="tc-grid tc-grid-then">
            <Field id={`tc-${index}-ring`} label="Ring for">
              <Select id={`tc-${index}-ring`} label="Ring for" value={String(c.ring_seconds)} options={ringOptions} onChange={v => onChange({ ring_seconds: Number(v) })} />
            </Field>
            <Field id={`tc-${index}-fallback`} label="If nobody accepts">
              <Select id={`tc-${index}-fallback`} label="If nobody accepts" value={c.if_no_answer} options={fallbackOptions} onChange={v => onChange({ if_no_answer: v })} />
            </Field>
          </div>
          <div className="tc-foot">
            {hoursOn ? (
              <Checkbox checked={c.hours_only} onChange={on => onChange({ hours_only: on })}>
                Only during business hours
              </Checkbox>
            ) : (
              <span className="tc-anytime">Any time (no business hours set)</span>
            )}
            {/* Inside the page's fieldset: disabled with it for members who cannot edit. */}
            <EditBusinessHours canEdit label={hoursOn ? 'Edit hours' : 'Set business hours'} />
            <Button size="sm" className="tc-done" onClick={onClose} title="Close this contact; Save keeps the changes">
              Done
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
