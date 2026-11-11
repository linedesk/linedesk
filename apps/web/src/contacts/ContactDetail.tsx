// The contact's record beside the list (full width below 1100 px): a header with who it is and the
// actions, the details as a form whose fields save themselves (contact.update), and their calls.
import type { Call, Contact } from '@callfront/db/types'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { CallBackLink } from '../call/ContactSide.tsx'
import { useInlineEdit } from '../call/EditableFact.tsx'
import { callTitle, formatPhone } from '../inbox-model.ts'
import { useRun } from '../store.tsx'
import { dateTimeLabel, parseTs, shortDuration } from '../time.ts'
import { Card, FormField, Input, Textarea } from '../ui/form.tsx'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { contactLabel, type ContactRow } from './model.ts'

type Props = {
  row: ContactRow
  toast: (text: string) => void
  onOpenCall: (call: Call) => void
  onClose: () => void
  onDelete: (contactId: string) => void
}

type Editable = 'name' | 'company' | 'email' | 'address' | 'note'

function DetailField({
  contact,
  field,
  label,
  placeholder,
  multiline,
}: {
  contact: Contact
  field: Editable
  label: string
  placeholder: string
  multiline?: boolean
}) {
  const run = useRun()
  const id = `ct-${field}`
  const edit = useInlineEdit({
    value: contact[field],
    onSave: value => void run('contact.update', { contactId: contact.id, [field]: value }),
    multiline,
  })
  return (
    <FormField id={id} label={label} className={multiline ? 'ct-wide' : undefined}>
      {multiline ? (
        <Textarea id={id} rows={3} placeholder={placeholder} {...edit} />
      ) : (
        <Input id={id} autoComplete="off" placeholder={placeholder} {...edit} />
      )}
    </FormField>
  )
}

/** ⋯ with Delete contact, which asks once in place; the toast then offers Undo. */
function MoreMenu({ label, onDelete }: { label: string; onDelete: () => void }) {
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
          )}
        </div>
      )}
    </div>
  )
}

function CallList({ calls, onOpen }: { calls: Call[]; onOpen: (call: Call) => void }) {
  if (!calls.length) return <p className="help">No calls yet.</p>
  return (
    <ul className="ct-calls">
      {calls.map(c => (
        <li key={c.id}>
          <button type="button" className="ct-call" onClick={() => onOpen(c)} title="Open the call">
            <b>{callTitle(c)}</b>
            <span className="ct-call-meta">
              {c.direction === 'out' ? 'Outbound' : 'Inbound'}
              {c.status === 'live' ? ' · live' : c.duration_sec ? ` · ${shortDuration(c.duration_sec)}` : ''}
            </span>
            <time className="ct-call-time" dateTime={c.started_at}>
              {dateTimeLabel(parseTs(c.started_at))}
            </time>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function ContactDetail({ row, onOpenCall, onClose, onDelete }: Props) {
  const { contact, calls } = row
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
            <MoreMenu label={label} onDelete={() => onDelete(contact.id)} />
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
            <DetailField contact={contact} field="note" label="Note" placeholder="Anything to remember" multiline />
          </div>
        </Card>
        <Card title={calls.length ? `Calls · ${calls.length}` : 'Calls'} className="ct-card">
          <CallList calls={calls} onOpen={onOpenCall} />
        </Card>
      </div>
    </aside>
  )
}
