// The contact's record beside the list (full width below 1100 px): a header with who it is and the
// actions, the details as a form whose fields save themselves (contact.update), and their calls.
import type { Call, Contact } from '@linedesk/db/types'
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { CallBackLink } from '../call/ContactSide.tsx'
import { useInlineEdit } from '../call/EditableFact.tsx'
import { formatPhone, tabOf } from '../inbox-model.ts'
import { type Change, doneChange, notDoneChange, type Step, unreadChange } from '../inbox/changes.ts'
import { Row } from '../inbox/Row.tsx'
import { useAssistants, useRun } from '../store.tsx'
import { dayLabel, parseTs } from '../time.ts'
import { Card, FormField, Input, Textarea } from '../ui/form.tsx'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { contactLabel, type ContactRow, noteHint } from './model.ts'

type Props = {
  row: ContactRow
  toast: (text: string) => void
  onOpenCall: (call: Call) => void
  onClose: () => void
  onDelete: (contactId: string) => void
  onMerge: () => void
  runUndoable: RunUndoable
}

type RunUndoable = (steps: Step[], inverse: Step[], label: string, key: string) => void

type Editable = 'name' | 'company' | 'email' | 'address' | 'note'

function DetailField({
  contact,
  field,
  label,
  placeholder,
  multiline,
  hint,
}: {
  contact: Contact
  field: Editable
  label: string
  placeholder: string
  multiline?: boolean
  /** A line under the field on what the value is used for. */
  hint?: string
}) {
  const run = useRun()
  const id = `ct-${field}`
  const hintId = hint ? `${id}-hint` : undefined
  const edit = useInlineEdit({
    value: contact[field],
    onSave: value => void run('contact.update', { contactId: contact.id, [field]: value }),
    multiline,
  })
  return (
    <FormField id={id} label={label} className={multiline ? 'ct-wide' : undefined}>
      {multiline ? (
        <Textarea id={id} rows={3} placeholder={placeholder} aria-describedby={hintId} {...edit} />
      ) : (
        <Input id={id} autoComplete="off" placeholder={placeholder} aria-describedby={hintId} {...edit} />
      )}
      {hint && (
        <p id={hintId} className="k-field-desc">
          {hint}
        </p>
      )}
    </FormField>
  )
}

/** ⋯ with Delete contact, which asks once in place; the toast then offers Undo. */
function MoreMenu({ label, onDelete, onMerge }: { label: string; onDelete: () => void; onMerge: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return setConfirming(false)
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEffect(() => {
    if (confirming) root.current?.querySelector<HTMLElement>('.ct-menu-confirm .k-btn-danger')?.focus()
  }, [confirming])
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return // closed: Esc closes the contact, as anywhere on the page
    e.stopPropagation()
    setOpen(false)
    root.current?.querySelector<HTMLElement>('.ct-more')?.focus()
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes the menu from the button or any item in it
    <div className="ct-menu-wrap" ref={root} onKeyDown={onKeyDown}>
      <Button
        size="sm"
        variant="ghost"
        icon="more"
        className="ct-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen(o => !o)}
      />
      {open && (
        <div className="ct-menu" role="menu" aria-label="Contact">
          {confirming ? (
            <div className="ct-menu-confirm">
              <span>Delete {label}? Their calls stay.</span>
              <span className="ct-menu-acts">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" onClick={onDelete}>
                  Delete
                </Button>
              </span>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="nav-item"
                onClick={() => {
                  setOpen(false)
                  onMerge()
                }}
              >
                <Icon name="users" size={15} />
                <span className="lbl">Merge with…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="nav-item ct-menu-danger"
                onClick={() => setConfirming(true)}
              >
                <Icon name="trash" size={15} />
                <span className="lbl">Delete contact…</span>
                <kbd className="k-kbd">#</kbd>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The contact's calls as the inbox shows them: the inbox's own row (unread dot, caller, topic, status,
 * length, time) under the same day labels, so the list is recognisable at a glance. Click or Enter
 * opens the call; the dot marks it read or unread and, on hover, E marks it done, both with undo.
 */
function CallList({
  calls,
  onOpen,
  runUndoable,
}: {
  calls: Call[]
  onOpen: (call: Call) => void
  runUndoable: RunUndoable
}) {
  if (!calls.length) return <p className="help">No calls yet.</p>
  const day = (c: Call) => dayLabel(parseTs(c.started_at))
  const apply = (change: Change) => runUndoable(change.steps, change.inverse, change.label, change.key)
  return (
    <div className="ib-list ct-calls" role="list" aria-label="Calls">
      {calls.map((c, i) => (
        <Fragment key={c.id}>
          {(i === 0 || day(calls[i - 1]!) !== day(c)) && (
            <div className="ib-day" role="presentation">
              {day(c)}
            </div>
          )}
          <Row
            call={c}
            tab={tabOf(c)}
            search={null}
            segments={[]}
            isCursor={false}
            motion={null}
            focusable
            onOpen={onOpen}
            onToggleUnread={call => apply(unreadChange(call))}
            onToggleDone={call => apply(call.inbox_state === 'done' ? notDoneChange(call) : doneChange(call))}
          />
        </Fragment>
      ))}
    </div>
  )
}

export function ContactDetail({ row, onOpenCall, onClose, onDelete, onMerge, runUndoable }: Props) {
  const { contact, calls } = row
  const assistantNames = useAssistants().map(a => a.name)
  const label = contactLabel(contact)
  const phone = formatPhone(contact.phone)
  return (
    <aside className="cv-side cust-side ct-detail" aria-label="Contact">
      <div className="ct-detail-in">
        <header className="ct-head">
          <Button
            size="sm"
            variant="ghost"
            icon="left"
            className="ct-back"
            aria-label="Close contact"
            title="Close (esc)"
            onClick={onClose}
          />
          <Avatar name={contact.name ?? '?'} size={40} />
          <div className="ct-who">
            <b>{label}</b>
            <span>{contact.name ? phone : (contact.company ?? 'No name yet')}</span>
          </div>
          <div className="ct-acts">
            {contact.phone.startsWith('+') && <CallBackLink number={contact.phone} />}
            <MoreMenu label={label} onDelete={() => onDelete(contact.id)} onMerge={onMerge} />
          </div>
        </header>
        <Card title="Details" className="ct-card">
          <div className="ct-grid" key={contact.id}>
            <DetailField contact={contact} field="name" label="Name" placeholder="Add a name" />
            <DetailField contact={contact} field="company" label="Company" placeholder="Add a company" />
            <FormField id="ct-phone" label="Phone">
              <Input id="ct-phone" value={phone} readOnly className="ct-readonly" />
            </FormField>
            <DetailField contact={contact} field="email" label="Email" placeholder="name@example.com" />
            <DetailField contact={contact} field="address" label="Address" placeholder="Street, city" />
            <DetailField
              contact={contact}
              field="note"
              label="Note"
              placeholder="Anything to remember"
              multiline
              hint={noteHint(assistantNames)}
            />
          </div>
        </Card>
        <Card title={calls.length ? `Calls · ${calls.length}` : 'Calls'} className="ct-card">
          <CallList calls={calls} onOpen={onOpenCall} runUndoable={runUndoable} />
        </Card>
      </div>
    </aside>
  )
}
