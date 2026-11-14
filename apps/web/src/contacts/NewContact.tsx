// Add a contact by hand, in the panel beside the list, with every detail a contact has: name and phone first,
// then the rest as on the contact page. Enter saves (Shift+Enter is a new line in the note), Esc closes.
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react'
import { useAssistants, useRun } from '../store.tsx'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { ContactField } from './ContactDetail.tsx'
import {
  CONTACT_DETAIL_FIELDS,
  EMPTY_NEW_CONTACT,
  NEW_CONTACT_MAX_LENGTH,
  type NewContactForm,
  newContactInput,
  noteHint,
} from './model.ts'

type Props = {
  /** Numbers already in Contacts, in E.164: adding one again says so instead of failing on the server. */
  existing: ReadonlySet<string>
  onAdded: (phone: string) => void
  onClose: () => void
}

/** Enter in the note saves the contact like in every other field; Shift+Enter starts a new line. */
function submitOnEnter(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
  e.preventDefault()
  e.currentTarget.form?.requestSubmit()
}

export function NewContact({ existing, onAdded, onClose }: Props) {
  const run = useRun()
  const assistantNames = useAssistants().map(a => a.name)
  const [form, setForm] = useState<NewContactForm>(EMPTY_NEW_CONTACT)
  const [problem, setProblem] = useState<string | null>(null)
  const phoneInput = useRef<HTMLInputElement>(null)
  const set = (field: keyof NewContactForm) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  function submit(e: FormEvent) {
    e.preventDefault()
    const result = newContactInput(form, existing)
    if (result.problem !== undefined) {
      setProblem(result.problem)
      return phoneInput.current?.focus() // the field the message is under
    }
    void run('contact.create', result.input)
    onAdded(result.input.phone)
  }

  return (
    <aside className="cv-side cust-side ct-detail" aria-label="New contact" data-esc-closes>
      <form className="ct-detail-in" onSubmit={submit} noValidate>
        <header className="ct-head">
          <div className="ct-who">
            <b>New contact</b>
          </div>
        </header>
        <Card className="ct-card">
          <div className="ct-grid">
            <ContactField
              id="ct-new-name"
              label="Name"
              placeholder="Add a name"
              value={form.name}
              maxLength={NEW_CONTACT_MAX_LENGTH.name}
              autoFocus
              onChange={set('name')}
            />
            <FormField id="ct-new-phone" label="Phone" error={problem}>
              <Input
                id="ct-new-phone"
                value={form.phone}
                inputMode="tel"
                autoComplete="off"
                placeholder="+1 503 555 0100"
                ref={phoneInput}
                invalid={!!problem}
                onChange={e => {
                  set('phone')(e)
                  setProblem(null)
                }}
              />
            </FormField>
          </div>
        </Card>
        <Card title="Details" className="ct-card">
          <div className="ct-grid">
            {CONTACT_DETAIL_FIELDS.map(({ field, ...f }) => (
              <ContactField
                key={field}
                id={`ct-new-${field}`}
                {...f}
                value={form[field]}
                maxLength={NEW_CONTACT_MAX_LENGTH[field]}
                hint={field === 'note' ? noteHint(assistantNames) : undefined}
                onChange={set(field)}
                onKeyDown={'multiline' in f ? submitOnEnter : undefined}
              />
            ))}
          </div>
        </Card>
        <div className="ct-new-acts">
          <Button variant="ghost" shortcut={['esc']} title="Close (esc)" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" shortcut={['⏎']} title="Add contact (⏎)">
            Add contact
          </Button>
        </div>
      </form>
    </aside>
  )
}
