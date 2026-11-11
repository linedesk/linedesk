// Settings > Assistant > Transfers: the people the assistant puts callers through to (warm transfer),
// each with a plain-language condition, in order. One compact row per contact; a row opens in place to
// edit it. Part of the assistant's draft: saved with the page's Save.
import { RING_SECONDS_MAX, RING_SECONDS_MIN } from '@linedesk/actions'
import type { TransferFallback } from '@linedesk/db/types'
import { useState } from 'react'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Button, cx } from '../ui/kit.tsx'
import {
  canAddTransfer,
  moveTransfer,
  newTransferContact,
  type TransferDraft,
  type TransferPreset,
  type TransferProblem,
  transferInactive,
  transferProblem,
} from './assistantDraft.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { Field, Section, SwitchRow, TextArea, TextInput } from './fields.tsx'

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
}

export function TransferContacts({ transfers, onChange, hoursOn, assistantName }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const problem = transferProblem({ transfers })
  const update = (index: number, patch: Partial<TransferDraft>) =>
    onChange(transfers.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  function add(preset: TransferPreset) {
    const contact = newTransferContact(transfers, preset)
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
          {transfers.map((c, i) => (
            <ContactRow
              key={c.id}
              contact={c}
              index={i}
              count={transfers.length}
              open={open === c.id || problem?.index === i}
              problem={problem?.index === i ? problem : null}
              hoursOn={hoursOn}
              onToggle={() => setOpen(open === c.id ? null : c.id)}
              onChange={patch => update(i, patch)}
              onMove={by => onChange(moveTransfer(transfers, i, by))}
              onRemove={() => onChange(transfers.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      ) : (
        <p className="tc-empty">No transfer contacts: {assistantName} takes a message on every call.</p>
      )}
      <div className="tc-add">
        <Button size="sm" icon="plus" disabled={!canAddTransfer({ transfers })} onClick={() => add('blank')}>
          Add contact
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canAddTransfer({ transfers })}
          onClick={() => add('emergency')}
          title="An on-call contact for emergencies: burst pipe, flooding, gas smell, no heat"
        >
          Add emergency contact
        </Button>
        {!transfers.some(c => /asks to speak to a person/i.test(c.condition)) && (
          <Button size="sm" variant="ghost" disabled={!canAddTransfer({ transfers })} onClick={() => add('person')}>
            Asks for a person
          </Button>
        )}
      </div>
    </Section>
  )
}

type RowProps = {
  contact: TransferDraft
  index: number
  count: number
  open: boolean
  problem: TransferProblem | null
  hoursOn: boolean
  onToggle: () => void
  onChange: (patch: Partial<TransferDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}

function ContactRow({
  contact: c,
  index,
  count,
  open,
  problem,
  hoursOn,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: RowProps) {
  const inactive = transferInactive(c)
  const name = c.name.trim() || 'New contact'
  const id = (field: TransferProblem['field']) => transferFieldId(index, field)
  const error = (field: TransferProblem['field']) => (problem?.field === field ? problem.message : null)
  return (
    <li className={cx('tc-row', inactive && 'is-off', open && 'is-open')}>
      <div className="tc-line">
        <span className="tc-order" aria-hidden>
          {index + 1}
        </span>
        <button
          type="button"
          className="tc-main"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Close' : 'Edit'}
        >
          <span className="tc-title">
            <b>{name}</b>
            <span className="tc-number">{c.number.trim() || 'No number'}</span>
          </span>
          <span className="tc-sub">
            {c.condition.trim() || 'No condition yet'}
            <span className="tc-meta">
              {' · '}
              {c.ring_seconds} s, {fallbackShort[c.if_no_answer]}
              {hoursOn && c.hours_only ? ', business hours only' : ''}
            </span>
          </span>
        </button>
        {inactive && <span className="tc-status">{inactive}</span>}
        <span className="tc-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="up"
            title="Move up"
            aria-label={`Move ${name} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="down"
            title="Move down"
            aria-label={`Move ${name} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            title="Remove"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          />
          <Switch on={c.enabled} onChange={on => onChange({ enabled: on })} label={`Transfer to ${name}`} />
        </span>
      </div>
      {open && (
        <div className="tc-edit">
          <div className="tc-pair">
            <Field id={id('name')} label="Name" error={error('name')}>
              <TextInput
                id={id('name')}
                value={c.name}
                onChange={v => onChange({ name: v })}
                placeholder="Mike (on-call)"
                invalid={!!error('name')}
              />
            </Field>
            <Field id={id('number')} label="Phone number" error={error('number')} tip="A US mobile or landline: the person's own phone, not a Linedesk number.">
              <TextInput
                id={id('number')}
                value={c.number}
                onChange={v => onChange({ number: v })}
                placeholder="+1 503 555 0100"
                invalid={!!error('number')}
              />
            </Field>
          </div>
          <Field id={id('condition')} label="When to put the caller through" error={error('condition')}>
            <TextArea
              id={id('condition')}
              value={c.condition}
              onChange={v => onChange({ condition: v })}
              placeholder="The caller asks for a person / Urgent: burst pipe, gas smell, no heat / Billing questions"
              invalid={!!error('condition')}
            />
          </Field>
          <div className="tc-pair">
            <Field id={`tc-${index}-ring`} label="Ring for">
              <Select
                id={`tc-${index}-ring`}
                label="Ring for"
                value={String(c.ring_seconds)}
                options={ringOptions}
                onChange={v => onChange({ ring_seconds: Number(v) })}
              />
            </Field>
            <Field id={`tc-${index}-fallback`} label="If nobody accepts">
              <Select
                id={`tc-${index}-fallback`}
                label="If nobody accepts"
                value={c.if_no_answer}
                options={fallbackOptions}
                onChange={v => onChange({ if_no_answer: v })}
              />
            </Field>
          </div>
          {hoursOn ? (
            <SwitchRow
              title="Only during business hours"
              on={c.hours_only}
              onChange={on => onChange({ hours_only: on })}
            />
          ) : (
            <span className="help">Any time (no business hours set).</span>
          )}
          {/* Inside the page's fieldset: disabled with it for members who cannot edit. */}
          <span className="as-hours-line">
            <EditBusinessHours canEdit label={hoursOn ? 'Edit business hours' : 'Set business hours'} />
          </span>
        </div>
      )}
    </li>
  )
}
