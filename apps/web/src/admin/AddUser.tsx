// Server admin › Users › Add user: puts someone into a workspace with a role (action user.invite). A new address gets an
// account and one email to sign in and join; an account whose address is confirmed joins at once. Only a server
// admin may be added without a workspace. A button above the user list opens the form as a dialog.
import { type MembershipRole, membershipRoles, type UserInviteData } from '@linedesk/actions'
import { type FormEvent, useState } from 'react'
import { emailError } from '../sign-in-code.ts'
import { roleLabel } from '../team/team-model.ts'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { adminGrantText, EnrolmentCodeDialog, enrolmentOf, type PasskeyEnrolment } from './actions.tsx'
import { type AdminWorkspace, runAdmin } from './api.ts'
import { errorText } from './notify.ts'

type Props = { workspaces: AdminWorkspace[]; toast: (text: string) => void; reload: () => Promise<void> }
/** `workspaceId`: '' none picked yet, NONE only for a server admin. */
type Form = { email: string; name: string; workspaceId: string; role: MembershipRole; admin: boolean }
type Errors = { email?: string; name?: string; workspace?: string; form?: string }

const NONE = 'none'
/** More workspaces than this: a search field above the list instead of a plain select. */
const SEARCH_FROM = 8
const roleOptions = membershipRoles.map(r => ({ value: r, label: roleLabel(r) }))
const WORKSPACE_HELP =
  'The workspace they join, with the role below. Only a server admin can be added without one: they run this server and can be added to a workspace later.'

/** What happened, in one line for the toast. */
export function addedText(data: Pick<UserInviteData, 'email' | 'existing' | 'delivery' | 'workspace'>): string {
  const ws = data.workspace
  const inLog = data.delivery === 'log'
  if (data.existing && ws?.joined === 'added') return `Already has an account; added to ${ws.name}.`
  if (data.existing && ws)
    return `Already has an account; invited to ${ws.name}. They join once they confirm their address.`
  if (ws)
    return `Added ${data.email} to ${ws.name}. ${inLog ? 'Their email is in the server log.' : 'They get an email to sign in and join.'}`
  return `Added ${data.email} as server admin. ${inLog ? 'Their email is in the server log.' : 'They get an email to sign in.'}`
}

/** Workspaces whose name matches the search, at most `limit`, by name. */
export function matchWorkspaces(workspaces: AdminWorkspace[], query: string, limit = 6): AdminWorkspace[] {
  const q = query.trim().toLowerCase()
  const sorted = [...workspaces].sort((a, b) => a.name.localeCompare(b.name))
  return (q ? sorted.filter(w => w.name.toLowerCase().includes(q)) : sorted).slice(0, limit)
}

type PickerProps = {
  workspaces: AdminWorkspace[]
  value: string
  allowNone: boolean
  invalid: boolean
  onPick: (id: string) => void
}

/** A select for a few workspaces; with many, a search field and the matches to pick from. */
function WorkspacePicker({ workspaces, value, allowNone, invalid, onPick }: PickerProps) {
  const [query, setQuery] = useState('')
  const none = { value: NONE, label: 'None' }
  if (workspaces.length <= SEARCH_FROM) {
    const options = [
      ...(allowNone ? [none] : []),
      ...matchWorkspaces(workspaces, '', workspaces.length).map(w => ({ value: w.id, label: w.name })),
    ]
    return <Select id="adm-add-workspace" value={value} options={options} label="Workspace" onChange={onPick} />
  }
  const shown = matchWorkspaces(workspaces, query)
  return (
    <>
      <Input
        id="adm-add-workspace"
        type="search"
        value={query}
        placeholder="Search workspaces"
        autoComplete="off"
        invalid={invalid}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="adm-pick" role="radiogroup" aria-label="Workspace">
        {allowNone && (
          <button
            type="button"
            role="radio"
            aria-checked={value === NONE}
            className="adm-pick-row adm-pick-plain"
            onClick={() => onPick(NONE)}
          >
            <span className="st-member-t">
              <b>None</b>
            </span>
          </button>
        )}
        {shown.map(w => (
          <button
            key={w.id}
            type="button"
            role="radio"
            aria-checked={w.id === value}
            className="adm-pick-row adm-pick-plain"
            onClick={() => onPick(w.id)}
          >
            <span className="st-member-t">
              <b>{w.name}</b>
            </span>
          </button>
        ))}
        {!shown.length && <p className="help">No workspace matches.</p>}
      </div>
    </>
  )
}

export function AddUser({ workspaces, toast, reload }: Props) {
  // People join a workspace that answers calls; a disabled one is refused anyway.
  const open = workspaces.filter(w => !w.disabled_at)
  const blank = (): Form => ({
    email: '',
    name: '',
    workspaceId: open.length === 1 ? open[0]!.id : '',
    role: 'member',
    admin: false,
  })
  const [shown, setShown] = useState(false)
  const [form, setForm] = useState<Form>(blank)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  /** Adding a server admin asks once more, in its own dialog. */
  const [confirmingAdmin, setConfirmingAdmin] = useState(false)
  const [enrolment, setEnrolment] = useState<{ who: string; enrolment: PasskeyEnrolment } | null>(null)
  const noWorkspace = form.workspaceId === NONE
  const picked = open.find(w => w.id === form.workspaceId)

  const close = () => {
    if (busy) return
    setShown(false)
    setForm(blank())
    setErrors({})
  }
  const set = (patch: Partial<Form>) => {
    setForm(f => {
      const next = { ...f, ...patch }
      // Without server admin, "None" is no choice.
      if (!next.admin && next.workspaceId === NONE) next.workspaceId = ''
      return next
    })
    setErrors({})
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || confirmingAdmin) return
    const found: Errors = {
      email: emailError(form.email) ?? undefined,
      name: form.name.trim() ? undefined : 'Enter their name.',
      workspace: form.workspaceId ? undefined : form.admin ? 'Choose a workspace, or None.' : 'Choose a workspace.',
    }
    if (found.email || found.name || found.workspace) {
      setErrors(found)
      const first = found.email ? 'adm-add-email' : found.name ? 'adm-add-name' : 'adm-add-workspace'
      return document.getElementById(first)?.focus()
    }
    if (form.admin) return setConfirmingAdmin(true)
    await send()
  }

  async function send() {
    setConfirmingAdmin(false)
    setBusy(true)
    try {
      const data = (await runAdmin('user.invite', {
        email: form.email,
        name: form.name,
        admin: form.admin,
        workspaceId: noWorkspace ? null : form.workspaceId,
        ...(noWorkspace ? {} : { role: form.role }),
      })) as unknown as UserInviteData
      // A new server admin: their first passkey needs this code, shown once.
      const made = enrolmentOf(data)
      if (made) setEnrolment({ who: form.email, enrolment: made })
      // The list shows them before the dialog closes (design principle 13).
      await reload()
      setBusy(false)
      setShown(false)
      setForm(blank())
      toast(addedText(data))
    } catch (err) {
      setErrors({ form: errorText(err) })
      setBusy(false)
    }
  }

  return (
    <>
      {enrolment && (
        <EnrolmentCodeDialog who={enrolment.who} enrolment={enrolment.enrolment} onClose={() => setEnrolment(null)} />
      )}
      <div>
        <Button size="sm" icon="plus" title="Add someone to a workspace" onClick={() => setShown(true)}>
          Add user
        </Button>
      </div>
      {shown && !confirmingAdmin && (
        <Dialog
          title="Add user"
          onClose={close}
          onSubmit={submit}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button busy={busy} type="submit" variant="primary" disabled={busy} title="Add user (⌘S)">
                {busy ? 'Adding…' : 'Add user'}
              </Button>
            </>
          }
        >
          <FormField id="adm-add-email" label="Email" error={errors.email}>
            <Input
              id="adm-add-email"
              type="email"
              autoComplete="off"
              invalid={!!errors.email}
              value={form.email}
              onChange={e => set({ email: e.target.value })}
            />
          </FormField>
          <FormField id="adm-add-name" label="Name" error={errors.name}>
            <Input
              id="adm-add-name"
              maxLength={80}
              autoComplete="off"
              invalid={!!errors.name}
              value={form.name}
              onChange={e => set({ name: e.target.value })}
            />
          </FormField>
          <FormField id="adm-add-workspace" label="Workspace" help={WORKSPACE_HELP} error={errors.workspace}>
            <WorkspacePicker
              workspaces={open}
              value={form.workspaceId}
              allowNone={form.admin}
              invalid={!!errors.workspace}
              onPick={workspaceId => set({ workspaceId })}
            />
          </FormField>
          {!noWorkspace && (
            <FormField id="adm-add-role" label={picked ? `Role in ${picked.name}` : 'Role'}>
              <Select
                id="adm-add-role"
                value={form.role}
                options={roleOptions}
                label="Role"
                onChange={role => set({ role })}
              />
            </FormField>
          )}
          <Checkbox checked={form.admin} onChange={admin => set({ admin })}>
            Server admin
          </Checkbox>
          {errors.form && <FormMessage>{errors.form}</FormMessage>}
        </Dialog>
      )}
      {confirmingAdmin && (
        <Dialog
          title="Add as server admin?"
          description={adminGrantText(form.email.trim())}
          size="sm"
          onClose={() => setConfirmingAdmin(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmingAdmin(false)}>
                Cancel
              </Button>
              <Button variant="danger-outline" onClick={() => void send()}>
                Add as server admin
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
