// Creates an account and emails the person how to sign in (action user.invite). The way people get in
// while sign-up is closed.
import { type FormEvent, useState } from 'react'
import { Checkbox } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
import { runAdmin } from './api.ts'

type Props = { toast: (text: string) => void; reload: () => Promise<void> }
const empty = { email: '', name: '', admin: false }

export function InviteUser({ toast, reload }: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setOpen(false)
    setForm(empty)
    setError(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const data = (await runAdmin('user.invite', { email: form.email, name: form.name, admin: form.admin })) as {
        delivery?: string
      }
      close()
      await reload()
      toast(
        data.delivery === 'log'
          ? `Invite sent to ${form.email}. The email is in the server log.`
          : `Invite sent to ${form.email}. They sign in with a code from the email.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div>
        <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
          Invite user
        </Button>
      </div>
    )
  }
  return (
    <form className="adm-keys adm-invite" onSubmit={submit} onKeyDown={e => e.key === 'Escape' && close()}>
      <div className="row2">
        <div className="field">
          <label htmlFor="adm-invite-email">Email</label>
          <span className="k-input">
            <input
              id="adm-invite-email"
              type="email"
              required
              autoFocus
              autoComplete="off"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            />
          </span>
        </div>
        <div className="field">
          <label htmlFor="adm-invite-name">Name</label>
          <span className="k-input">
            <input
              id="adm-invite-name"
              required
              maxLength={80}
              autoComplete="off"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </span>
        </div>
      </div>
      <Checkbox className="adm-check" checked={form.admin} onChange={admin => setForm(f => ({ ...f, admin }))}>
        Instance admin: sees every workspace and user, and sets the provider keys
      </Checkbox>
      <div className="adm-keys-foot">
        <span className="help">
          We email them: they sign in with this address and a one-time code. They join a workspace when someone there
          invites them.
        </span>
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send invite'}
        </Button>
      </div>
      {error && (
        <span className="adm-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}
