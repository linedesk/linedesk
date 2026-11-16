// The contact's record beside the list (full width below 1100 px): a header with who it is and the
// actions, the details as a form whose fields save themselves (contact.update), and their calls.
import type { Call, Contact } from '@linedesk/db/types'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { CallLink, ConfirmCallerName, nameFromCaller } from '../call/ContactSide.tsx'
import { useInlineEdit } from '../call/EditableFact.tsx'
import { formatPhone } from '../inbox-model.ts'
import type { Step } from '../inbox/changes.ts'
import { useAssistants, useRun } from '../store.tsx'
import { Card, FormField, Input, Textarea } from '../ui/form.tsx'
import { NO_PASSWORD_MANAGER } from '../ui/passwordManager.ts'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { ContactCalls } from './ContactCalls.tsx'
import { CONTACT_DETAIL_FIELDS, type ContactDetailField, contactLabel, type ContactRow, noteHint } from './model.ts'
import { useT } from '@linedesk/i18n/react'

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

type Editable = 'name' | ContactDetailField

/** The contact page shows the phone right after the company. */
const [company, ...afterPhone] = CONTACT_DETAIL_FIELDS

type FieldProps = {
  id: string
  label: string
  placeholder: string
  multiline?: boolean
  /** A line under the field on what the value is used for. */
  hint?: ReactNode
  autoFocus?: boolean
  maxLength?: number
  value: string
  onChange: (e: { target: { value: string } }) => void
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  onFocus?: () => void
  onBlur?: () => void
}

/** One field of a contact, as the contact page and New contact show it: a line, or a box for the note. */
export function ContactField({ id, label, multiline, hint, ...control }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <FormField id={id} label={label} className={multiline ? 'ct-wide' : undefined}>
      {multiline ? (
        <Textarea id={id} rows={3} aria-describedby={hintId} {...control} />
      ) : (
        <Input id={id} {...NO_PASSWORD_MANAGER} aria-describedby={hintId} {...control} />
      )}
      {hint && (
        <p id={hintId} className="k-field-desc">
          {hint}
        </p>
      )}
    </FormField>
  )
}

/** A field of the contact page: saves itself (contact.update) on Enter or when left. */
function DetailField({
  contact,
  field,
  ...rest
}: {
  contact: Contact
  field: Editable
  label: string
  placeholder: string
  multiline?: boolean
  hint?: ReactNode
}) {
  const run = useRun()
  const edit = useInlineEdit({
    value: contact[field],
    onSave: value => void run('contact.update', { contactId: contact.id, [field]: value }),
    multiline: rest.multiline,
  })
  return <ContactField id={`ct-${field}`} {...rest} {...edit} />
}

/** ⋯ with Delete contact, which asks once in place; the toast then offers Undo. */
function MoreMenu({ label, onDelete, onMerge }: { label: string; onDelete: () => void; onMerge: () => void }) {
  const t = useT()
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
        aria-label={t('contacts.detail.more')}
        title={t('contacts.detail.more')}
        onClick={() => setOpen(o => !o)}
      />
      {open && (
        <div className="ct-menu" role="menu" aria-label={t('call.contact.label')}>
          {confirming ? (
            <div className="ct-menu-confirm">
              <span>{t('contacts.detail.deleteConfirm', { name: label })}</span>
              <span className="ct-menu-acts">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  {t('common.action.cancel')}
                </Button>
                <Button size="sm" variant="danger" onClick={onDelete}>
                  {t('common.action.delete')}
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
                <span className="lbl">{t('contacts.detail.mergeWith')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="nav-item ct-menu-danger"
                onClick={() => setConfirming(true)}
              >
                <Icon name="trash" size={15} />
                <span className="lbl">{t('contacts.detail.delete')}</span>
                <kbd className="k-kbd">#</kbd>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ContactDetail({ row, onOpenCall, onClose, onDelete, onMerge, runUndoable }: Props) {
  const t = useT()
  const { contact, calls } = row
  const assistantNames = useAssistants().map(a => a.name)
  const label = contactLabel(contact)
  const phone = formatPhone(contact.phone)
  return (
    <aside className="cv-side cust-side ct-detail" aria-label={t('call.contact.label')} data-esc-closes>
      <div className="ct-detail-in">
        <header className="ct-head">
          <Button
            size="sm"
            variant="ghost"
            icon="left"
            className="ct-back"
            aria-label={t('call.contact.close')}
            title={t('common.action.closeWithKey', { key: 'esc' })}
            onClick={onClose}
          />
          <Avatar name={contact.name ?? '?'} size={40} />
          <div className="ct-who">
            <b>{label}</b>
            <span>{contact.name ? phone : (contact.company ?? t('contacts.detail.noName'))}</span>
          </div>
          <div className="ct-acts">
            {contact.phone.startsWith('+') && <CallLink number={contact.phone} />}
            <MoreMenu label={label} onDelete={() => onDelete(contact.id)} onMerge={onMerge} />
          </div>
        </header>
        <Card title={t('contacts.detail.details')} className="ct-card">
          <div className="ct-grid" key={contact.id}>
            <DetailField
              contact={contact}
              field="name"
              label={t('contacts.field.name')}
              placeholder={t('contacts.field.namePlaceholder')}
              hint={nameFromCaller(contact) ? <ConfirmCallerName contact={contact} /> : undefined}
            />
            <DetailField
              contact={contact}
              field={company.field}
              label={t(company.label)}
              placeholder={t(company.placeholder)}
            />
            <FormField id="ct-phone" label={t('contacts.field.phone')}>
              <Input id="ct-phone" value={phone} readOnly className="ct-readonly" />
            </FormField>
            {afterPhone.map(f => (
              <DetailField
                key={f.field}
                contact={contact}
                field={f.field}
                label={t(f.label)}
                placeholder={t(f.placeholder)}
                multiline={'multiline' in f}
                hint={f.field === 'note' ? noteHint(assistantNames) : undefined}
              />
            ))}
          </div>
        </Card>
        <Card
          title={calls.length ? t('contacts.detail.callsCount', { count: calls.length }) : t('contacts.column.calls')}
          className="ct-card"
        >
          <ContactCalls
            key={contact.id}
            calls={calls}
            onOpen={onOpenCall}
            onChange={change => runUndoable(change.steps, change.inverse, change.label, change.key)}
          />
        </Card>
      </div>
    </aside>
  )
}
