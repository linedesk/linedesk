// Add a contact by hand, in the panel beside the list. Enter saves, Esc closes.
import { useRef, useState, type FormEvent } from 'react'
import { toE164 } from '../onboarding/flow.ts'
import { useRun } from '../store.tsx'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'

type Props = {
  /** Numbers already in Contacts, in E.164: adding one again says so instead of failing on the server. */
  existing: ReadonlySet<string>
  onAdded: (phone: string) => void
  onClose: () => void
}

export function NewContact({ existing, onAdded, onClose }: Props) {
  const run = useRun()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const phoneInput = useRef<HTMLInputElement>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const e164 = toE164(phone)
    const problem = !phone.trim()
      ? 'Enter a phone number.'
      : !e164
        ? 'Enter a US phone number, like +1 503 555 0100.'
        : existing.has(e164)
          ? 'That number is already in Contacts.'
          : null
    if (problem) {
      setProblem(problem)
      return phoneInput.current?.focus() // the field the message is under
    }
    if (!e164) return
    const trimmed = (value: string) => value.trim() || undefined
    void run('contact.create', { phone: e164, name: trimmed(name), company: trimmed(company) })
    onAdded(e164)
  }

  return (
    <aside className="cv-side cust-side ct-detail" aria-label="New contact">
      <form className="ct-detail-in" onSubmit={submit} noValidate>
        <header className="ct-head">
          <div className="ct-who">
            <b>New contact</b>
          </div>
        </header>
        <Card className="ct-card">
          <div className="ct-grid">
            <FormField id="ct-new-name" label="Name">
              <Input
                id="ct-new-name"
                value={name}
                autoFocus
                autoComplete="off"
                onChange={e => setName(e.target.value)}
              />
            </FormField>
            <FormField id="ct-new-phone" label="Phone" error={problem}>
              <Input
                id="ct-new-phone"
                value={phone}
                inputMode="tel"
                autoComplete="off"
                placeholder="+1 503 555 0100"
                ref={phoneInput}
                invalid={!!problem}
                onChange={e => {
                  setPhone(e.target.value)
                  setProblem(null)
                }}
              />
            </FormField>
            <FormField id="ct-new-company" label="Company" aside="Optional">
              <Input
                id="ct-new-company"
                value={company}
                autoComplete="off"
                onChange={e => setCompany(e.target.value)}
              />
            </FormField>
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
