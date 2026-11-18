// What an admin can do to a user or a workspace, in one place: the detail page shows the actions as
// a row of buttons, the list as quick icon buttons on each row (and a ⋯ menu on phones and touch screens).
// Actions that change access ask once in a dialog; the rest run at once.
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useState } from 'react'
import { brandName } from '../brand.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { confirmText, reasonField, startImpersonation } from '../impersonation.ts'
import { keepAccountsOption, numberLines, workspaceDeleteList } from '../settings/dangerZoneModel.ts'
import { confirmErrorText, type DangerConfirmation, DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import type { IconName } from '../ui/icons.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { MenuButton, type MenuItem } from '../ui/list.tsx'
import { type AdminUser, type AdminWorkspace, runAdmin } from './api.ts'
import { ClientPartnerDialog } from './ClientPartner.tsx'
import { errorText, type Notify } from './notify.ts'

type Confirmation = DangerConfirmation
type Translate = ReturnType<typeof i18n>['t']
/** The active language's `t`, looked up on each call (the language can change while the module stays loaded). */
const t = ((...args: Parameters<Translate>) => i18n().t(...args)) as Translate

export type AdminAction = {
  id: string
  /** The button's words; a trailing … means it asks first. */
  label: string
  icon: IconName
  /** What it does, for the tooltip. */
  tip: string
  confirm?: Confirmation
  /**
   * May resolve with a PasskeyEnrolment when the action made one (shown once, in its dialog). `option`: whether the
   * confirmation's checkbox is ticked; `reason`: the text its confirmation asked for (`confirm.reason`).
   */
  run: (option?: boolean, reason?: string) => Promise<unknown>
  /** The toast afterwards; a function gets what `run` resolved with. */
  done?: string | ((made: unknown) => string)
  /** Whom it is about, for its result ("Give this code to …"). */
  subject?: string
  /** Destroys data (Delete workspace): its button is red, as in Workspace settings › Danger zone. */
  danger?: boolean
  /** Why it cannot run now: the detail page shows the button disabled with this next to it. */
  disabledReason?: string
  /** A dialog of its own instead of the confirmation (it runs the action itself; `run` is not called). */
  dialog?: (close: () => void, notify: Notify) => ReactNode
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
  const t = useT()
  return (
    <Dialog
      title={t('admin.actions.enrolment.title')}
      description={t('admin.actions.enrolment.description', {
        who,
        until: fmt().dateTime(new Date(enrolment.expiresAt), { dateStyle: 'medium', timeStyle: 'short' }),
      })}
      size="sm"
      onClose={onClose}
      onSubmit={e => {
        e.preventDefault()
        onClose()
      }}
      footer={
        <Button type="submit" variant="primary">
          {t('admin.actions.enrolment.done')}
        </Button>
      }
    >
      <Input
        readOnly
        value={enrolment.code}
        aria-label={t('admin.actions.enrolment.codeLabel')}
        onFocus={e => e.currentTarget.select()}
      />
    </Dialog>
  )
}

/** A user's passkeys as the grant dialog lists them: they become the new admin's second factor. */
export function existingPasskeysText(passkeys: NonNullable<AdminUser['passkeys']>): string {
  const list = passkeys.map(p => {
    const name =
      p.name || t(p.device_type === 'multiDevice' ? 'admin.actions.passkey.synced' : 'admin.actions.passkey.device')
    return p.created_at ? t('admin.actions.passkey.addedOn', { name, date: fmt().date(new Date(p.created_at)) }) : name
  })
  return t('admin.actions.passkey.existing', {
    count: passkeys.length,
    list: fmt().list(list, { type: 'unit', style: 'short' }),
  })
}

/** What granting server admin means, said before it happens (detail, row and Add user). */
export const adminGrantText = (who: string) => t('admin.actions.grantText', { who })

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
      label: t('admin.actions.user.impersonate.label', { name }),
      icon: 'user',
      tip: t('admin.actions.user.impersonate.tip', { brand: brandName() }),
      confirm: {
        text: confirmText(name),
        action: t('admin.actions.user.impersonate.action', { name }),
        variant: 'primary',
        reason: reasonField(),
      },
      // Reloads into the app as this user; throws with the reason when refused.
      run: (_option, reason) => startImpersonation(u.id, reason ?? ''),
    })
  if (!u.instance_admin && !u.disabled_at)
    actions.push({
      id: 'grant',
      label: t('admin.actions.user.grant.label'),
      icon: 'shield',
      tip: t('admin.actions.user.grant.tip'),
      confirm: {
        text: u.passkeys?.length ? `${adminGrantText(name)} ${existingPasskeysText(u.passkeys)}` : adminGrantText(name),
        action: t('admin.actions.user.grant.action'),
        variant: 'danger-outline',
        // Their existing passkeys become the admin second factor: start over when unsure they are all theirs.
        ...(u.passkeys?.length
          ? {
              alternative: {
                action: t('admin.actions.user.grant.alternative'),
                tip: t('admin.actions.user.grant.alternativeTip'),
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
      done: t('admin.actions.user.grant.done', { name }),
    })
  if (u.instance_admin && !isSelf && !u.instance_admin_by_env)
    actions.push({
      id: 'revoke',
      label: t('admin.actions.user.revoke.label'),
      icon: 'shield',
      tip: t('admin.actions.user.revoke.tip'),
      confirm: {
        text: t('admin.actions.user.revoke.text', { name }),
        action: t('admin.actions.user.revoke.action'),
      },
      run: act('instanceAdmin.revoke'),
      done: t('admin.actions.user.revoke.done', { name }),
    })
  // An admin without a passkey only needs the code for their first: nothing to reset, nobody signed out.
  if (u.instance_admin && !isSelf && !u.disabled_at && u.passkeys?.length === 0)
    actions.push({
      id: 'enrolment-code',
      label: t('admin.actions.user.enrolmentCode.label'),
      icon: 'shield',
      tip: t('admin.actions.user.enrolmentCode.tip'),
      confirm: {
        text: t('admin.actions.user.enrolmentCode.text', { name }),
        action: t('admin.actions.user.enrolmentCode.action'),
        variant: 'primary',
      },
      run: act('user.issuePasskeyEnrolment'),
      subject: name,
      done: t('admin.actions.user.enrolmentCode.done', { name }),
    })
  if (!isSelf && !u.disabled_at)
    actions.push({
      id: 'reset-passkeys',
      label: t('admin.actions.user.resetPasskeys.label'),
      icon: 'restart',
      tip: t('admin.actions.user.resetPasskeys.tip'),
      confirm: {
        text: t(
          u.instance_admin ? 'admin.actions.user.resetPasskeys.textAdmin' : 'admin.actions.user.resetPasskeys.textUser',
          { name },
        ),
        action: t('admin.actions.user.resetPasskeys.action'),
      },
      run: act('user.resetPasskeys'),
      subject: name,
      done: t('admin.actions.user.resetPasskeys.done', { name }),
    })
  if (u.disabled_at)
    actions.push({
      id: 'enable',
      label: t('admin.actions.user.enable.label'),
      icon: 'restart',
      tip: t('admin.actions.user.enable.tip'),
      run: act('user.enable'),
      done: t('admin.actions.user.enable.done', { name }),
    })
  else if (!isSelf)
    actions.push({
      id: 'disable',
      label: t('admin.actions.user.disable.label'),
      icon: 'ban',
      tip: t('admin.actions.user.disable.tip'),
      confirm: {
        text: t('admin.actions.user.disable.text', { name }),
        action: t('admin.actions.user.disable.action'),
      },
      run: act('user.disable'),
      done: t('admin.actions.user.disable.done', { name }),
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
    text: t('admin.actions.workspace.delete.text', { name: w.name }),
    list: workspaceDeleteList({
      calls: w.calls_total,
      contacts: w.contacts,
      numbers: numberLines(w.phone_numbers.length, brandName()),
      otherMembers: Math.max(0, w.members - (viewerIsMember ? 1 : 0)),
      accountsDeleted,
    }),
    option: keepAccountsOption({ accountsDeleted, ownAccountDeleted: false }),
    after: t('admin.actions.workspace.delete.after'),
  }
}

/** The toast after a delete: numbers left at the carrier are named, since someone has to release them there. */
export function deletedWorkspaceText(name: string, data: unknown): string {
  const numbers = (
    (data as { numbers?: { e164: string; carrier: string; note?: string }[] } | null)?.numbers ?? []
  ).filter(n => n.carrier === 'left')
  const left = numbers
    .map(n =>
      t('admin.actions.workspace.deleted.number', {
        number: n.e164,
        note: n.note ?? t('admin.actions.workspace.deleted.leftAtCarrier'),
      }),
    )
    .join('; ')
  const users = (data as { usersDeleted?: string[] } | null)?.usersDeleted?.length ?? 0
  // Whole sentences, one after the other.
  return [
    t('admin.actions.workspace.deleted.done', { name }),
    ...(users ? [t('admin.actions.workspace.deleted.accounts', { count: users })] : []),
    ...(left ? [t('admin.actions.workspace.deleted.atCarrier', { numbers: left })] : []),
  ].join(' ')
}

/** The workspace's owner among the users, if it has one (one owner per workspace). */
export const ownerOf = (w: Pick<AdminWorkspace, 'id'>, users: readonly AdminUser[]) =>
  users.find(u => u.workspaces.some(m => m.id === w.id && m.role === 'owner'))

/**
 * Server admin › Workspaces › a workspace: sign in as its owner, opening in this workspace. The same refusals as
 * Users › Sign in as (yourself, a disabled user, a server admin) show as a disabled button with the reason; no
 * owner, no button.
 */
export function signInAsOwnerAction(
  w: Pick<AdminWorkspace, 'id'>,
  users: readonly AdminUser[],
  currentUserId: string,
): AdminAction | null {
  const owner = ownerOf(w, users)
  if (!owner) return null
  const name = userLabel(owner)
  const disabledReason =
    owner.id === currentUserId
      ? t('admin.actions.workspace.signInAsOwner.self')
      : owner.disabled_at
        ? t('admin.actions.workspace.signInAsOwner.disabled', { name })
        : owner.instance_admin
          ? t('admin.actions.workspace.signInAsOwner.admin', { name })
          : undefined
  return {
    id: 'impersonate-owner',
    label: t('admin.actions.user.impersonate.label', { name }),
    icon: 'user',
    tip: t('admin.actions.workspace.signInAsOwner.tip', { brand: brandName(), name }),
    confirm: {
      text: confirmText(name),
      action: t('admin.actions.user.impersonate.action', { name }),
      variant: 'primary',
      reason: reasonField(),
    },
    run: (_option, reason) => startImpersonation(owner.id, reason ?? '', w.id),
    ...(disabledReason ? { disabledReason } : {}),
  }
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
    label: t('admin.actions.workspace.delete.label'),
    icon: 'trash',
    danger: true,
    tip: t('admin.actions.workspace.delete.tip'),
    confirm: {
      ...deleteWorkspaceText(w, viewerIsMember),
      action: t('admin.actions.workspace.delete.action'),
      busyAction: t('admin.actions.workspace.delete.busy'),
      typed: w.name,
    },
    run: async keepAccounts => {
      const data = await runAdmin('workspace.delete', { workspaceId: w.id, name: w.name, keepAccounts: !!keepAccounts })
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
          label: t('admin.actions.workspace.enable.label'),
          icon: 'restart',
          tip: t('admin.actions.workspace.enable.tip'),
          run: set(false),
          done: t('admin.actions.workspace.enable.done', { name: w.name }),
        },
      ]
    : [
        {
          id: 'disable',
          label: t('admin.actions.workspace.disable.label'),
          icon: 'ban',
          tip: t('admin.actions.workspace.disable.tip'),
          confirm: {
            text: t('admin.actions.workspace.disable.text', { name: w.name }),
            action: t('admin.actions.workspace.disable.action'),
            typed: w.name,
          },
          run: set(true),
          done: t('admin.actions.workspace.disable.done', { name: w.name }),
        },
      ]
  const partner: AdminAction = {
    id: 'partner',
    label: t('admin.clientPartner.open'),
    icon: 'move',
    tip: w.partner_name
      ? t('admin.clientPartner.tipWith', { partner: w.partner_name })
      : t('admin.clientPartner.tipWithout'),
    run: async () => {},
    dialog: (close, notify) => <ClientPartnerDialog workspace={w} onClose={close} notify={notify} reload={reload} />,
  }
  return [...toggle, partner, remove]
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
  if (enrolment)
    return (
      <EnrolmentCodeDialog
        who={action.subject ?? t('admin.actions.enrolment.them')}
        enrolment={enrolment}
        onClose={onClose}
      />
    )
  return (
    <DangerConfirmDialog
      confirm={{
        ...confirm,
        ...(confirm.alternative
          ? { alternative: { ...confirm.alternative, run: async () => settle(await confirm.alternative!.run()) } }
          : {}),
      }}
      run={async (option, reason) => settle(await action.run(option, reason))}
      onClose={onClose}
    />
  )
}

/** Runs a picked action: at once, or after its confirmation dialog. Render `dialog` somewhere. */
export function useActionRunner(notify: Notify) {
  const [pending, setPending] = useState<AdminAction | null>(null)
  async function pick(action: AdminAction) {
    if (action.confirm || action.dialog) return setPending(action)
    try {
      const made = await action.run()
      if (action.done) notify(doneText(action, made))
    } catch (err) {
      notify(errorText(err))
    }
  }
  const close = () => setPending(null)
  const dialog =
    pending &&
    (pending.dialog ? (
      pending.dialog(close, notify)
    ) : (
      <ConfirmDialog action={pending} notify={notify} onClose={close} />
    ))
  return { pick: (action: AdminAction) => void pick(action), dialog }
}

/** The detail page's actions: a row of buttons under the title. */
export function ActionBar({ actions, onPick }: { actions: AdminAction[]; onPick: (action: AdminAction) => void }) {
  if (!actions.length) return null
  const blocked = actions.filter(a => a.disabledReason)
  return (
    <div className="adm-actbar">
      {actions.map(a => (
        <Button
          key={a.id}
          size="sm"
          icon={a.icon}
          variant={a.danger ? 'danger-outline' : undefined}
          title={a.disabledReason ?? a.tip}
          disabled={!!a.disabledReason}
          aria-describedby={a.disabledReason ? `adm-act-why-${a.id}` : undefined}
          onClick={() => onPick(a)}
        >
          {a.label}
        </Button>
      ))}
      {blocked.map(a => (
        <span key={a.id} id={`adm-act-why-${a.id}`} className="adm-actbar-why">
          {a.disabledReason}
        </span>
      ))}
    </div>
  )
}

/** A row's quick actions: icon buttons on hover or focus, a ⋯ menu on touch screens. */
export function RowActions({ actions, onPick }: { actions: AdminAction[]; onPick: (action: AdminAction) => void }) {
  const t = useT()
  if (!actions.length) return null
  const items: MenuItem[] = actions.map(a => ({
    id: a.id,
    label: a.label,
    lead: <Icon name={a.icon} size={15} />,
    danger: a.danger,
    title: a.tip,
    onSelect: () => onPick(a),
  }))
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the row's click (open) away from its buttons
    <div className="adm-rowacts" onClick={e => e.stopPropagation()}>
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
            onClick={() => onPick(a)}
          />
        ))}
      </span>
      <span className="adm-rowacts-more">
        <MenuButton items={items} title={t('admin.actions.menu')} />
      </span>
    </div>
  )
}
