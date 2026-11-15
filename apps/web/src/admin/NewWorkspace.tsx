// Server admin › Workspaces › New workspace: only server admins create workspaces, so the admin creates one for a
// business and gives it its owner (workspace.create).
import type { WorkspaceCreateData } from '@linedesk/actions'
import { type FormEvent, useState } from 'react'
import { emailError } from '../sign-in-code.ts'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { runAdmin } from './api.ts'
import { errorText } from './notify.ts'

type Form = { name: string; ownerEmail: string; ownerName: string }
type Errors = { name?: string; ownerEmail?: string; form?: string }
const blank: Form = { name: '', ownerEmail: '', ownerName: '' }

/** One line for the toast. */
export function createdText(data: WorkspaceCreateData): string {
  const { workspace, owner } = data
  if (owner.joined === 'added') return `Created ${workspace.name}; ${owner.email} is its owner.`
  return `Created ${workspace.name}; ${owner.email} gets an email and becomes its owner once they confirm their address.`
}

/** Server admin › Workspaces › New workspace: the business's name and its owner's address (and name, if new). */
export function NewWorkspace({ toast, reload }: { toast: (text: string) => void; reload: () => Promise<void> }) {
  const [shown, setShown] = useState(false)
  const [form, setForm] = useState<Form>(blank)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (busy) return
    setShown(false)
    setForm(blank)
    setErrors({})
  }
  const set = (patch: Partial<Form>) => {
    setForm(f => ({ ...f, ...patch }))
    setErrors({})
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const found: Errors = {
      name: form.name.trim() ? undefined : 'Enter the business name.',
      ownerEmail: emailError(form.ownerEmail) ?? undefined,
    }
    if (found.name || found.ownerEmail) {
      setErrors(found)
      return document.getElementById(found.name ? 'adm-new-ws-name' : 'adm-new-ws-owner')?.focus()
    }
    setBusy(true)
    try {
      const data = (await runAdmin('workspace.create', {
        name: form.name.trim(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        owner: { email: form.ownerEmail.trim(), ...(form.ownerName.trim() ? { name: form.ownerName.trim() } : {}) },
      })) as unknown as WorkspaceCreateData
      // The list shows it before the dialog closes.
      await reload()
      setBusy(false)
      setShown(false)
      setForm(blank)
      toast(createdText(data))
    } catch (err) {
      setErrors({ form: errorText(err) })
      setBusy(false)
    }
  }
  return (
    <>
      <div>
        <Button
          size="sm"
          icon="plus"
          title="Create a workspace for a business and give it an owner"
          onClick={() => setShown(true)}
        >
          New workspace
        </Button>
      </div>
      {shown && (
        <Dialog
          title="New workspace"
          description="For a business, with its assistant. Its owner sets it up; you don't join it."
          onClose={close}
          onSubmit={submit}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button busy={busy} type="submit" variant="primary" disabled={busy} title="Create workspace (⌘S)">
                {busy ? 'Creating…' : 'Create workspace'}
              </Button>
            </>
          }
        >
          <FormField id="adm-new-ws-name" label="Business name" error={errors.name}>
            <Input
              id="adm-new-ws-name"
              maxLength={80}
              autoComplete="off"
              invalid={!!errors.name}
              value={form.name}
              onChange={e => set({ name: e.target.value })}
            />
          </FormField>
          <FormField
            id="adm-new-ws-owner"
            label="Owner's email"
            help="An existing account with a confirmed address becomes the owner at once. Anyone else gets an email and becomes the owner once they confirm their address."
            error={errors.ownerEmail}
          >
            <Input
              id="adm-new-ws-owner"
              type="email"
              autoComplete="off"
              invalid={!!errors.ownerEmail}
              value={form.ownerEmail}
              onChange={e => set({ ownerEmail: e.target.value })}
            />
          </FormField>
          <FormField
            id="adm-new-ws-owner-name"
            label="Owner's name"
            help="For a new account. Leave empty for an existing one."
          >
            <Input
              id="adm-new-ws-owner-name"
              maxLength={80}
              autoComplete="off"
              value={form.ownerName}
              onChange={e => set({ ownerName: e.target.value })}
            />
          </FormField>
          {errors.form && <FormMessage>{errors.form}</FormMessage>}
        </Dialog>
      )}
    </>
  )
}
