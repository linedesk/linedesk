// Add a contact by hand, in the panel beside the list. Enter saves, Esc closes.
import { useRef, useState, type FormEvent } from 'react'
import { toE164 } from '../onboarding/flow.ts'
import { useRun } from '../store.tsx'
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
        ? 'Enter a US phone number, like +1 503 555 0142.'
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
    <aside className="cv-side cust-side" aria-label="New contact">
      <form className="ct-new" onSubmit={submit}>
        <b>New contact</b>
        <label>
          <span>Name</span>
          <input
            className="k-input"
            value={name}
            autoFocus
            autoComplete="off"
            onChange={e => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Phone</span>
          <input
            className="k-input"
            value={phone}
            inputMode="tel"
            autoComplete="off"
            placeholder="+1 503 555 0142"
            ref={phoneInput}
            aria-invalid={!!problem}
            aria-describedby={problem ? 'ct-new-phone-problem' : undefined}
            onChange={e => {
              setPhone(e.target.value)
              setProblem(null)
            }}
          />
        </label>
        {problem && (
          <span className="ct-new-problem" id="ct-new-phone-problem" role="alert">
            {problem}
          </span>
        )}
        <label>
          <span>Company</span>
          <input className="k-input" value={company} autoComplete="off" onChange={e => setCompany(e.target.value)} />
        </label>
        <div className="ct-new-acts">
          <Button size="sm" variant="ghost" shortcut={['esc']} title="Close (esc)" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" shortcut={['⏎']} title="Add contact (⏎)">
            Add contact
          </Button>
        </div>
      </form>
    </aside>
  )
}
