// Add a contact by hand, in the panel beside the list. Enter saves, Esc closes.
import { useState, type FormEvent } from 'react'
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

  function submit(e: FormEvent) {
    e.preventDefault()
    const e164 = toE164(phone)
    if (!e164) return setProblem('Enter a US phone number, like (503) 555-0142.')
    if (existing.has(e164)) return setProblem('That number is already in Contacts.')
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
            placeholder="(503) 555-0142"
            aria-invalid={!!problem}
            onChange={e => {
              setPhone(e.target.value)
              setProblem(null)
            }}
          />
        </label>
        <label>
          <span>Company</span>
          <input className="k-input" value={company} autoComplete="off" onChange={e => setCompany(e.target.value)} />
        </label>
        {problem && (
          <span className="ct-new-problem" role="alert">
            {problem}
          </span>
        )}
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
