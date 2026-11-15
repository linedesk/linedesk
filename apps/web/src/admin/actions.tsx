// What an admin can do to a user or a workspace, in one place: the detail page shows the actions as
// a row of buttons, the list as quick icon buttons on each row (and a ⋯ menu on touch screens).
// Actions that change access ask once in a dialog; the rest run at once.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { brandName } from '../brand.ts'
import { fmt } from '../i18n/format.ts'
import { confirmText, startImpersonation } from '../impersonation.ts'
import { keepAccountsOption, numberLines, workspaceDeleteList } from '../settings/dangerZoneModel.ts'
import { confirmErrorText, type DangerConfirmation, DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import type { IconName } from '../ui/icons.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { type AdminUser, type AdminWorkspace, runAdmin } from './api.ts'
import { errorText, type Notify } from './notify.ts'

type Confirmation = DangerConfirmation

export type AdminAction = {
  id: string
  /** The button's words; a trailing … means it asks first. */
  label: string
  icon: IconName
  /** What it does, for the tooltip. */
  tip: string
  confirm?: Confirmation
  /** May resolve with a PasskeyEnrolment when the action made one (shown once, in its dialog). `option`: whether the confirmation's checkbox is ticked. */
  run: (option?: boolean) => Promise<unknown>
  /** The toast afterwards; a function gets what `run` resolved with. */
  done?: string | ((made: unknown) => string)
  /** Whom it is about, for its result ("Give this code to …"). */
  subject?: string
  /** Destroys data (Delete workspace): its button is red, as in Workspace settings › Danger zone. */
  danger?: boolean
}

const userLabel = (u: AdminUser) => u.name || u.email

/** A new server admin's one-time code for their first passkey (apps/api/src/passkey-enrolment.ts). */
export type PasskeyEnrolment = { code: string; expiresAt: string }

const isEnrolment = (value: unknown): value is PasskeyEnrolment =>
  typeof value === 'object' && value !== null && typeof (value as PasskeyEnrolment).code === 'string'

/** The code in an action's result, if it made one. */
export const enrolmentOf = (data: Record<string, unknown>): PasskeyEnrolment | undefined =>
  typeof data.enrolmentCode === 'string'
    ? { code: data.enrolmentCode, expiresAt: String(data.enrolmentExpiresAt ?? '') }
    : undefined

/** Shows an enrolment code once: the admin passes it on; nobody can see it again. */
export function EnrolmentCodeDialog({
  who,
  enrolment,
  onClose,
}: {
  who: string
  enrolment: PasskeyEnrolment
  onClose: () => void
}) {
  return (
    <Dialog
      title="Passkey enrolment code"
      description={`Give this code to ${who}. Their first passkey needs it (Account, Sign-in & security, Add passkey). It works once, until ${fmt().dateTime(new Date(enrolment.expiresAt), { dateStyle: 'medium', timeStyle: 'short' })}, and is not shown again.`}
      size="sm"
      onClose={onClose}
      onSubmit={e => {
        e.preventDefault()
        onClose()
      }}
      footer={
        <Button type="submit" variant="primary">
          Done
        </Button>
      }
    >
      <Input readOnly value={enrolment.code} aria-label="Enrolment code" onFocus={e => e.currentTarget.select()} />
    </Dialog>
  )
}

/** A user's passkeys as the grant dialog lists them: they become the new admin's second factor. */
export function existingPasskeysText(passkeys: NonNullable<AdminUser['passkeys']>): string {
  const list = passkeys
    .map(
      p =>
        `${p.name || (p.device_type === 'multiDevice' ? 'Synced passkey' : 'Passkey on a device')}${p.created_at ? ` (added ${fmt().date(new Date(p.created_at))})` : ''}`,
    )
    .join(', ')
  return `They already have ${passkeys.length === 1 ? 'a passkey' : `${passkeys.length} passkeys`}: ${list}. These open the admin area for them. If you are not sure they are all theirs, reset them instead: you get a one-time code for their new first passkey.`
}

/** What granting server admin means, said before it happens (detail, row and Add user). */
export const adminGrantText = (who: string) =>
  `Make ${who} a server admin? They can see every workspace and user, change provider keys and sign in as other users.`

/** The actions that apply to this user: none of them on yourself except what is harmless. */
export function userActions(u: AdminUser, currentUserId: string, reload: () => Promise<void>): AdminAction[] {
  const name = userLabel(u)
  const isSelf = u.id === currentUserId
  const act =
    (
      action:
        | 'user.disable'
        | 'user.enable'
        | 'instanceAdmin.grant'
        | 'instanceAdmin.revoke'
        | 'user.resetPasskeys'
        | 'user.issuePasskeyEnrolment',
    ) =>
    async () => {
      const data = await runAdmin(action, { userId: u.id })
      await reload()
      return enrolmentOf(data)
    }
  const actions: AdminAction[] = []
  if (!isSelf && !u.instance_admin && !u.disabled_at)
    actions.push({
      id: 'impersonate',
      label: `Sign in as ${name}…`,
      icon: 'user',
      tip: `See ${brandName()} exactly as they do, for up to an hour. Recorded as done by you.`,
      confirm: { text: confirmText(name), action: `Sign in as ${name}`, variant: 'primary' },
      // Reloads into the app as this user; throws with the reason when refused.
      run: () => startImpersonation(u.id),
    })
  if (!u.instance_admin && !u.disabled_at)
    actions.push({
      id: 'grant',
      label: 'Make server admin…',
      icon: 'shield',
      tip: 'Sees every workspace and user, and sets the provider keys.',
      confirm: {
        text: u.passkeys?.length ? `${adminGrantText(name)} ${existingPasskeysText(u.passkeys)}` : adminGrantText(name),
        action: 'Make server admin',
        variant: 'danger-outline',
        // Their existing passkeys become the admin second factor: start over when unsure they are all theirs.
        ...(u.passkeys?.length
          ? {
              alternative: {
                action: 'Reset passkeys and make server admin',
                tip: 'Removes their passkeys, signs them out and gives you a one-time code for their new first passkey.',
                run: async () => {
                  await runAdmin('instanceAdmin.grant', { userId: u.id })
                  const data = await runAdmin('user.resetPasskeys', { userId: u.id })
                  await reload()
                  return enrolmentOf(data)
                },
              },
            }
          : {}),
      },
      run: act('instanceAdmin.grant'),
      subject: name,
      done: `${name}: now a server admin.`,
    })
  if (u.instance_admin && !isSelf && !u.instance_admin_by_env)
    actions.push({
      id: 'revoke',
      label: 'Remove server admin…',
      icon: 'shield',
      tip: 'They keep their workspaces and lose access to Server admin.',
      confirm: { text: `${name} loses access to Server admin.`, action: 'Remove server admin' },
      run: act('instanceAdmin.revoke'),
      done: `${name}: no longer a server admin.`,
    })
  // An admin without a passkey only needs the code for their first: nothing to reset, nobody signed out.
  if (u.instance_admin && !isSelf && !u.disabled_at && u.passkeys?.length === 0)
    actions.push({
      id: 'enrolment-code',
      label: 'Give passkey code…',
      icon: 'shield',
      tip: 'A one-time code for their first passkey. Nothing is removed and they stay signed in.',
      confirm: {
        text: `Make a one-time code for the first passkey of ${name}? They are emailed; their sessions and AI agent setup links keep working.`,
        action: 'Make code',
        variant: 'primary',
      },
      run: act('user.issuePasskeyEnrolment'),
      subject: name,
      done: `The code for ${name} is made.`,
    })
  if (!isSelf && !u.disabled_at)
    actions.push({
      id: 'reset-passkeys',
      label: 'Reset passkeys…',
      icon: 'restart',
      tip: 'Removes every passkey of theirs, for a lost device or a passkey they did not add. Signs them out everywhere and ends their AI agent setup links. They are emailed.',
      confirm: {
        text: u.instance_admin
          ? `Remove every passkey of ${name}? They are signed out everywhere, their AI agent setup links end, they are emailed, and you get a one-time code for their new first passkey.`
          : `Remove every passkey of ${name}? They are signed out everywhere, their AI agent setup links end and they are emailed; they sign in with an email code or password and add a new one.`,
        action: 'Reset passkeys',
      },
      run: act('user.resetPasskeys'),
      subject: name,
      done: `The passkeys of ${name} are removed.`,
    })
  if (u.disabled_at)
    actions.push({
      id: 'enable',
      label: 'Enable',
      icon: 'restart',
      tip: 'They can sign in again.',
      run: act('user.enable'),
      done: `${name} can sign in again.`,
    })
  else if (!isSelf)
    actions.push({
      id: 'disable',
      label: 'Disable…',
      icon: 'ban',
      tip: 'Signs them out everywhere; they cannot sign in until enabled.',
      confirm: {
        text: `${name} is signed out everywhere and cannot sign in again until enabled.`,
        action: 'Disable user',
      },
      run: act('user.disable'),
      done: `${name} is disabled and signed out.`,
    })
  return actions
}

/**
 * What deleting the workspace removes, said before it happens: the same list as an owner's delete in Workspace
 * settings (settings/dangerZoneModel.ts). `viewerIsMember`: the admin deleting it is a member, so they are no
 * "other member" (they get no email either). Instance admins keep their accounts, so the admin is never among the
 * accounts that go (members_only_here).
 */
export function deleteWorkspaceText(
  w: AdminWorkspace,
  viewerIsMember = false,
): Pick<Confirmation, 'text' | 'list' | 'after' | 'option'> {
  const accountsDeleted = w.members_only_here
  return {
    text: `This deletes ${w.name} and all its data for good.`,
    list: workspaceDeleteList({
      calls: w.calls_total,
      contacts: w.contacts,
      numbers: numberLines(w.phone_numbers.length, brandName()),
      otherMembers: Math.max(0, w.members - (viewerIsMember ? 1 : 0)),
      accountsDeleted,
    }),
    option: keepAccountsOption({ accountsDeleted, ownAccountDeleted: false }),
    after: 'This cannot be undone.',
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${fmt().number(n)} ${n === 1 ? one : many}`

/** The toast after a delete: numbers left at the carrier are named, since someone has to release them there. */
export function deletedWorkspaceText(name: string, data: unknown): string {
  const numbers = (
    (data as { numbers?: { e164: string; carrier: string; note?: string }[] } | null)?.numbers ?? []
  ).filter(n => n.carrier === 'left')
  const left = numbers.map(n => `${n.e164}: ${n.note ?? 'left at the carrier'}`).join('; ')
  const users = (data as { usersDeleted?: string[] } | null)?.usersDeleted?.length ?? 0
  const accounts = users ? ` ${count(users, 'account')} deleted with it.` : ''
  return `${name} is deleted.${accounts}${left ? ` Still at the carrier: ${left}.` : ''}`
}

/** `onDeleted`: leave the page of a workspace that is gone. `viewerIsMember`: the admin is a member of it. */
export function workspaceActions(
  w: AdminWorkspace,
  reload: () => Promise<void>,
  { onDeleted, viewerIsMember = false }: { onDeleted?: () => void; viewerIsMember?: boolean } = {},
): AdminAction[] {
  const set = (disabled: boolean) => async () => {
    await runAdmin(disabled ? 'workspace.disable' : 'workspace.enable', { workspaceId: w.id })
    await reload()
  }
  const remove: AdminAction = {
    id: 'delete',
    label: 'Delete workspace…',
    icon: 'trash',
    danger: true,
    tip: 'Deletes it with all its calls, contacts, numbers and settings, and the accounts of members who belong to no other workspace.',
    confirm: {
      ...deleteWorkspaceText(w, viewerIsMember),
      action: 'Delete workspace',
      busyAction: 'Deleting…',
      typed: w.name,
    },
    run: async keepAccounts => {
      // Both names, the same value, for this one release: an API from before the rename reads only keepUsers
      // and would drop keepAccounts, deleting the accounts the box kept (security review of #756, F1).
      const data = await runAdmin('workspace.delete', {
        workspaceId: w.id,
        name: w.name,
        keepAccounts: !!keepAccounts,
        keepUsers: !!keepAccounts,
      })
      onDeleted?.()
      await reload()
      return data
    },
    done: made => deletedWorkspaceText(w.name, made),
  }
  const toggle: AdminAction[] = w.disabled_at
    ? [
        {
          id: 'enable',
          label: 'Enable',
          icon: 'restart',
          tip: 'Calls to its numbers are answered again.',
          run: set(false),
          done: `${w.name} is enabled. Its calls are answered again.`,
        },
      ]
    : [
        {
          id: 'disable',
          label: 'Disable…',
          icon: 'ban',
          tip: 'Its numbers stop being answered; members can still sign in and read.',
          confirm: {
            text: `Calls to ${w.name} will no longer be answered and its members can only read.`,
            action: 'Disable workspace',
            typed: w.name,
          },
          run: set(true),
          done: `${w.name} is disabled. Its calls are no longer answered.`,
        },
      ]
  return [...toggle, remove]
}

const doneText = (action: AdminAction, made: unknown) =>
  typeof action.done === 'function' ? action.done(made) : (action.done ?? '')

/** Why a confirmed action did not go through (ui/DangerConfirmDialog.tsx, shared with Workspace settings). */
export { confirmErrorText }

function ConfirmDialog({ action, onClose, notify }: { action: AdminAction; onClose: () => void; notify: Notify }) {
  const [enrolment, setEnrolment] = useState<PasskeyEnrolment | null>(null)
  const settle = async (made: unknown) => {
    if (action.done) notify(doneText(action, made))
    if (isEnrolment(made)) return setEnrolment(made)
    onClose()
  }
  const confirm = action.confirm!
  if (enrolment) return <EnrolmentCodeDialog who={action.subject ?? 'them'} enrolment={enrolment} onClose={onClose} />
  return (
    <DangerConfirmDialog
      confirm={{
        ...confirm,
        ...(confirm.alternative
          ? { alternative: { ...confirm.alternative, run: async () => settle(await confirm.alternative!.run()) } }
          : {}),
      }}
      run={async option => settle(await action.run(option))}
      onClose={onClose}
    />
  )
}

/** Runs a picked action: at once, or after its confirmation dialog. Render `dialog` somewhere. */
export function useActionRunner(notify: Notify) {
  const [pending, setPending] = useState<AdminAction | null>(null)
  async function pick(action: AdminAction) {
    if (action.confirm) return setPending(action)
    try {
      const made = await action.run()
      if (action.done) notify(doneText(action, made))
    } catch (err) {
      notify(errorText(err))
    }
  }
  const dialog = pending && <ConfirmDialog action={pending} notify={notify} onClose={() => setPending(null)} />
  return { pick: (action: AdminAction) => void pick(action), dialog }
}

/** The detail page's actions: a row of buttons under the title. */
export function ActionBar({ actions, onPick }: { actions: AdminAction[]; onPick: (action: AdminAction) => void }) {
  if (!actions.length) return null
  return (
    <div className="adm-actbar">
      {actions.map(a => (
        <Button
          key={a.id}
          size="sm"
          icon={a.icon}
          variant={a.danger ? 'danger-outline' : undefined}
          title={a.tip}
          onClick={() => onPick(a)}
        >
          {a.label}
        </Button>
      ))}
    </div>
  )
}

/** A row's quick actions: icon buttons on hover or focus, a ⋯ menu on touch screens. */
export function RowActions({ actions, onPick }: { actions: AdminAction[]; onPick: (action: AdminAction) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  if (!actions.length) return null
  const choose = (a: AdminAction) => {
    setOpen(false)
    onPick(a)
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return
    e.stopPropagation()
    setOpen(false)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the row's click (open) away from its buttons; Esc closes the menu
    <div className="adm-rowacts" ref={root} onClick={e => e.stopPropagation()} onKeyDown={onKeyDown}>
      <span className="adm-rowacts-icons">
        {actions.map(a => (
          <Button
            key={a.id}
            size="sm"
            variant="ghost"
            icon={a.icon}
            aria-label={a.label.replace('…', '')}
            title={a.label.replace('…', '')}
            data-desc={a.tip}
            onClick={() => choose(a)}
          />
        ))}
      </span>
      <span className="adm-rowacts-more">
        <Button
          size="sm"
          variant="ghost"
          icon="more"
          aria-label="Actions"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Actions"
          onClick={() => setOpen(o => !o)}
        />
        {open && (
          <div className="adm-rowmenu" role="menu">
            {actions.map(a => (
              <button key={a.id} type="button" role="menuitem" className="nav-item" onClick={() => choose(a)}>
                <Icon name={a.icon} size={15} />
                <span className="lbl">{a.label}</span>
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  )
}
