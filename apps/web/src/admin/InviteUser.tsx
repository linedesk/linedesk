// Creates an account and emails the person how to sign in (action user.invite). The way people get in
// while sign-up is closed. A button above the user list opens the form as a dialog.
import { type FormEvent, useState } from 'react'
import { emailError } from '../sign-in-code.ts'
import { Checkbox } from '../ui/controls.tsx'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { adminGrantText, EnrolmentCodeDialog, enrolmentOf, type PasskeyEnrolment } from './actions.tsx'
import { runAdmin } from './api.ts'

type Props = { toast: (text: string) => void; reload: () => Promise<void> }
const empty = { email: '', name: '', admin: false }
type Errors = { email?: string; name?: string; form?: string }

export function InviteUser({ toast, reload }: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  /** Inviting an instance admin asks once more, in its own dialog. */
  const [confirmingAdmin, setConfirmingAdmin] = useState(false)
  const [enrolment, setEnrolment] = useState<{ who: string; enrolment: PasskeyEnrolment } | null>(null)

  const close = () => {
    if (busy) return
    setOpen(false)
    setForm(empty)
    setErrors({})
  }
  const set = (patch: Partial<typeof empty>) => {
    setForm(f => ({ ...f, ...patch }))
    setErrors({})
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || confirmingAdmin) return
    const found: Errors = {
      email: emailError(form.email) ?? undefined,
      name: form.name.trim() ? undefined : 'Enter their name.',
    }
    if (found.email || found.name) {
      setErrors(found)
      return document.getElementById(found.email ? 'adm-invite-email' : 'adm-invite-name')?.focus()
    }
    if (form.admin) return setConfirmingAdmin(true)
    await send()
  }

  async function send() {
    setConfirmingAdmin(false)
    setBusy(true)
    try {
      const data = (await runAdmin('user.invite', { email: form.email, name: form.name, admin: form.admin })) as {
        delivery?: string
      }
      // A new instance admin: their first passkey needs this code, shown once.
      const made = enrolmentOf(data)
      if (made) setEnrolment({ who: form.email, enrolment: made })
      setBusy(false)
      setOpen(false)
      setForm(empty)
      await reload()
      toast(
        data.delivery === 'log' ? `Invite for ${form.email} is in the server log.` : `Invite sent to ${form.email}.`,
      )
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : String(err) })
      setBusy(false)
    }
  }

  return (
    <>
      {enrolment && <EnrolmentCodeDialog who={enrolment.who} enrolment={enrolment.enrolment} onClose={() => setEnrolment(null)} />}
      <div>
        <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
          Invite user
        </Button>
      </div>
      {open && !confirmingAdmin && (
        <Dialog
          title="Invite user"
          onClose={close}
          onSubmit={submit}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button busy={busy} type="submit" variant="primary" disabled={busy} title="Send invite (⌘S)">
                {busy ? 'Sending…' : 'Send invite'}
              </Button>
            </>
          }
        >
          <FormField id="adm-invite-email" label="Email" error={errors.email}>
            <Input
              id="adm-invite-email"
              type="email"
              autoComplete="off"
              invalid={!!errors.email}
              value={form.email}
              onChange={e => set({ email: e.target.value })}
            />
          </FormField>
          <FormField id="adm-invite-name" label="Name" error={errors.name}>
            <Input
              id="adm-invite-name"
              maxLength={80}
              autoComplete="off"
              invalid={!!errors.name}
              value={form.name}
              onChange={e => set({ name: e.target.value })}
            />
          </FormField>
          <Checkbox checked={form.admin} onChange={admin => set({ admin })}>
            Instance admin
          </Checkbox>
          {errors.form && <FormMessage>{errors.form}</FormMessage>}
        </Dialog>
      )}
      {confirmingAdmin && (
        <Dialog
          title="Invite as instance admin?"
          description={adminGrantText(form.email.trim())}
          size="sm"
          onClose={() => setConfirmingAdmin(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmingAdmin(false)}>
                Cancel
              </Button>
              <Button variant="danger-outline" onClick={() => void send()}>
                Invite as admin
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
