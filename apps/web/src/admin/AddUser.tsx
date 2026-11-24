// Server admin › Users › Add user: puts someone into a workspace with a role (action user.invite). A new address gets an
// account and one email to sign in and join; an account whose address is confirmed joins at once. Only a server
// admin may be added without a workspace. A button above the user list opens the form as a dialog.
import { type MembershipRole, membershipRoles, type UserInviteData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { emailError } from '../sign-in-code.ts'
import { roleLabel } from '../team/team-model.ts'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { NO_PASSWORD_MANAGER } from '../ui/passwordManager.ts'
import { Button } from '../ui/kit.tsx'
import { adminGrantText, EnrolmentCodeDialog, enrolmentOf, type PasskeyEnrolment } from './actions.tsx'
import { type AdminUser, type AdminWorkspace, runAdmin } from './api.ts'
import { errorText } from './notify.ts'

type Props = {
  workspaces: AdminWorkspace[]
  /** Who is where: a workspace with an owner (or an owner invitation) takes no second one (membership.add refuses). */
  users: AdminUser[]
  toast: (text: string) => void
  reload: () => Promise<void>
}
/** `workspaceId`: '' none picked yet, NONE only for a server admin. */
type Form = { email: string; name: string; workspaceId: string; role: MembershipRole; admin: boolean }
type Errors = { email?: string; name?: string; workspace?: string; form?: string }

const NONE = 'none'
/** More workspaces than this: a search field above the list instead of a plain select. */
const SEARCH_FROM = 8
/** Built on each use: the labels follow the active language. */
const roleOptions = () => membershipRoles.map(r => ({ value: r, label: roleLabel(r) }))

/** The workspaces that have an owner, or an owner invitation pending: the server refuses a second one. */
export function workspacesWithOwner(users: Pick<AdminUser, 'workspaces' | 'invitations'>[]): Set<string> {
  const owned = new Set<string>()
  for (const u of users) {
    for (const w of u.workspaces) if (w.role === 'owner') owned.add(w.id)
    for (const i of u.invitations) if (i.role === 'owner') owned.add(i.workspace_id)
  }
  return owned
}

/** The roles to pick from in `workspaceId`: Owner is shown off, with why, where the workspace has one. */
export function roleChoices(hasOwner: boolean) {
  return roleOptions().map(o =>
    o.value === 'owner' && hasOwner ? { ...o, disabled: true, description: i18n().t('admin.addUser.hasOwner') } : o,
  )
}

/** What happened, in one line for the toast. */
export function addedText(data: Pick<UserInviteData, 'email' | 'existing' | 'delivery' | 'workspace'>): string {
  const { t } = i18n()
  const ws = data.workspace
  const inLog = data.delivery === 'log'
  if (data.existing && ws?.joined === 'added') return t('admin.addUser.added.existingAdded', { workspace: ws.name })
  if (data.existing && ws) return t('admin.addUser.added.existingInvited', { workspace: ws.name })
  if (ws)
    return t(inLog ? 'admin.addUser.added.toWorkspaceLog' : 'admin.addUser.added.toWorkspace', {
      email: data.email,
      workspace: ws.name,
    })
  return t(inLog ? 'admin.addUser.added.adminLog' : 'admin.addUser.added.admin', { email: data.email })
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
  const t = useT()
  const [query, setQuery] = useState('')
  const none = { value: NONE, label: t('admin.addUser.none') }
  if (workspaces.length <= SEARCH_FROM) {
    const options = [
      ...(allowNone ? [none] : []),
      ...matchWorkspaces(workspaces, '', workspaces.length).map(w => ({ value: w.id, label: w.name })),
    ]
    return (
      <Select
        id="adm-add-workspace"
        value={value}
        options={options}
        label={t('admin.addUser.workspace')}
        onChange={onPick}
      />
    )
  }
  const shown = matchWorkspaces(workspaces, query)
  return (
    <>
      <Input
        id="adm-add-workspace"
        type="search"
        value={query}
        placeholder={t('admin.addUser.searchWorkspaces')}
        {...NO_PASSWORD_MANAGER}
        invalid={invalid}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="adm-pick" role="radiogroup" aria-label={t('admin.addUser.workspace')}>
        {allowNone && (
          <button
            type="button"
            role="radio"
            aria-checked={value === NONE}
            className="adm-pick-row adm-pick-plain"
            onClick={() => onPick(NONE)}
          >
            <span className="st-member-t">
              <b>{t('admin.addUser.none')}</b>
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
        {!shown.length && <p className="help">{t('admin.addUser.noMatch')}</p>}
      </div>
    </>
  )
}

export function AddUser({ workspaces, users, toast, reload }: Props) {
  const t = useT()
  // People join a workspace that answers calls; a disabled one is refused anyway.
  const open = workspaces.filter(w => !w.disabled_at)
  const owned = workspacesWithOwner(users)
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
      // Owner was picked, then a workspace that has one: back to Member.
      if (next.role === 'owner' && owned.has(next.workspaceId)) next.role = 'member'
      return next
    })
    setErrors({})
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || confirmingAdmin) return
    const found: Errors = {
      email: emailError(form.email) ?? undefined,
      name: form.name.trim() ? undefined : t('admin.addUser.nameMissing'),
      workspace: form.workspaceId
        ? undefined
        : t(form.admin ? 'admin.addUser.workspaceOrNone' : 'admin.addUser.workspaceMissing'),
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
        <Button size="sm" icon="plus" title={t('admin.addUser.openTip')} onClick={() => setShown(true)}>
          {t('admin.addUser.open')}
        </Button>
      </div>
      {shown && !confirmingAdmin && (
        <Dialog
          title={t('admin.addUser.title')}
          onClose={close}
          onSubmit={submit}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                {t('common.action.cancel')}
              </Button>
              <Button
                busy={busy}
                type="submit"
                variant="primary"
                disabled={busy}
                title={t('common.withKey', { label: t('admin.addUser.submit'), key: '⌘S' })}
              >
                {busy ? t('admin.addUser.adding') : t('admin.addUser.submit')}
              </Button>
            </>
          }
        >
          <FormField id="adm-add-email" label={t('admin.addUser.email')} error={errors.email}>
            <Input
              id="adm-add-email"
              type="email"
              placeholder={t('admin.example.ownerEmail')}
              {...NO_PASSWORD_MANAGER}
              invalid={!!errors.email}
              value={form.email}
              onChange={e => set({ email: e.target.value })}
            />
          </FormField>
          <FormField id="adm-add-name" label={t('admin.addUser.name')} error={errors.name}>
            <Input
              id="adm-add-name"
              maxLength={80}
              {...NO_PASSWORD_MANAGER}
              invalid={!!errors.name}
              value={form.name}
              onChange={e => set({ name: e.target.value })}
            />
          </FormField>
          <FormField
            id="adm-add-workspace"
            label={t('admin.addUser.workspace')}
            help={t('admin.addUser.workspaceHelp')}
            error={errors.workspace}
          >
            <WorkspacePicker
              workspaces={open}
              value={form.workspaceId}
              allowNone={form.admin}
              invalid={!!errors.workspace}
              onPick={workspaceId => set({ workspaceId })}
            />
          </FormField>
          {!noWorkspace && (
            <FormField
              id="adm-add-role"
              label={picked ? t('admin.addUser.roleIn', { workspace: picked.name }) : t('admin.addUser.role')}
            >
              <Select
                id="adm-add-role"
                value={form.role}
                options={roleChoices(owned.has(form.workspaceId))}
                label={t('admin.addUser.role')}
                onChange={role => set({ role })}
              />
            </FormField>
          )}
          <Checkbox checked={form.admin} onChange={admin => set({ admin })}>
            {t('admin.addUser.serverAdmin')}
          </Checkbox>
          {errors.form && <FormMessage>{errors.form}</FormMessage>}
        </Dialog>
      )}
      {confirmingAdmin && (
        <Dialog
          title={t('admin.addUser.confirmAdmin.title')}
          description={adminGrantText(form.email.trim())}
          size="sm"
          onClose={() => setConfirmingAdmin(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmingAdmin(false)}>
                {t('common.action.cancel')}
              </Button>
              <Button variant="danger-outline" onClick={() => void send()}>
                {t('admin.addUser.confirmAdmin.action')}
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
