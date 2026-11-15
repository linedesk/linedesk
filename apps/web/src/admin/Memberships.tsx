// Who belongs where, for an instance admin: a user's workspaces and a workspace's members, each
// with role, remove and pending invitations (resend, revoke), and a dialog to add someone directly.
// Every change is a membership.* or invitation.* action; the server keeps a last owner.
import { type MembershipRole, membershipRoles } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { removeMemberConfirmation, roleLabel } from '../team/team-model.ts'
import { Select } from '../ui/controls.tsx'
import { Card, Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Avatar, Badge, Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { type AdminAction, useActionRunner } from './actions.tsx'
import { type AdminUser, type AdminWorkspace, loadWorkspaceMembers, runAdmin, type WorkspaceMembers } from './api.ts'
import { errorText, type Notify } from './notify.ts'
import { day } from './parts.tsx'
import { WorkspaceMark } from '../shell/WorkspaceMark.tsx'

/** Built on each use: the labels follow the active language. */
const roleOptions = () => membershipRoles.map(r => ({ value: r, label: roleLabel(r) }))
const asRole = (role: string): MembershipRole =>
  membershipRoles.includes(role as MembershipRole) ? (role as MembershipRole) : 'member'

/** What Add to workspace did: a confirmed address joins at once, an unconfirmed one is invited (membership.add). */
export const addedNote = (who: string, where: string, data: { joined?: unknown }) =>
  i18n().t(data.joined === 'invited' ? 'admin.memberships.invited' : 'admin.memberships.added', { who, where })

/** Runs a change, then refreshes and says what happened; a refusal becomes the toast. */
function useChange(notify: Notify, refresh: () => Promise<void>) {
  return useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      try {
        await work()
        await refresh()
        notify(done)
      } catch (err) {
        notify(errorText(err))
      }
    },
    [notify, refresh],
  )
}

type MemberRowProps = {
  title: string
  sub?: string
  /** A person: their profile picture or initials; a workspace: its square (WorkspaceMark), as everywhere else. */
  lead: 'person' | 'workspace'
  avatarUrl?: string | null
  role: string
  onRole: (role: MembershipRole) => void
  onRemove: () => void
  removeLabel: string
}

/** The owner is never demoted or removed directly, only replaced (another member made owner): plain text, no remove. */
function MemberRow({ title, sub, lead, avatarUrl, role, onRole, onRemove, removeLabel }: MemberRowProps) {
  const t = useT()
  return (
    <ListRow
      lead={
        lead === 'workspace' ? (
          <WorkspaceMark name={title} iconUrl={null} />
        ) : (
          <Avatar name={title} size={24} src={avatarUrl} />
        )
      }
      title={title}
      sub={sub}
      actions={
        role === 'owner' ? (
          <span className="help st-role" title={t('admin.memberships.ownerTip')}>
            {roleLabel(role)}
          </span>
        ) : (
          <>
            <Select
              size="sm"
              align="end"
              value={asRole(role)}
              options={roleOptions()}
              label={t('admin.memberships.roleIn', { name: title })}
              onChange={onRole}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={onRemove}
            />
          </>
        )
      }
    />
  )
}

type InviteRowProps = {
  title: string
  sub: string
  role: string
  expired?: boolean
  /** An invitation listed by its workspace (a user's page): the workspace's square. */
  workspace?: boolean
  onResend: () => void
  onRevoke: () => void
}

function InviteRow({ title, sub, role, expired, workspace, onResend, onRevoke }: InviteRowProps) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  return (
    <ListRow
      lead={workspace ? <WorkspaceMark name={title} iconUrl={null} /> : <Avatar name={title} size={24} />}
      title={
        <>
          {title}
          <Badge>{expired ? t('admin.memberships.badge.expired') : t('admin.memberships.badge.invited')}</Badge>
        </>
      }
      sub={sub}
      aside={roleLabel(role)}
      actions={
        <span className="team-inv-actions">
          <Button size="sm" variant="ghost" title={t('admin.memberships.resendTip')} onClick={onResend}>
            {t('admin.memberships.resend')}
          </Button>
          <Button
            size="sm"
            variant={confirming ? 'danger' : 'ghost'}
            title={confirming ? t('admin.memberships.revokeConfirmTip') : t('admin.memberships.revokeTip')}
            onBlur={() => setConfirming(false)}
            onClick={() => (confirming ? onRevoke() : setConfirming(true))}
          >
            {confirming ? t('admin.memberships.revokeConfirm') : t('admin.memberships.revoke')}
          </Button>
        </span>
      }
    />
  )
}

/**
 * Removing someone: when it is their only workspace their account goes too (never a server admin's), unless the box
 * keeps it (team-model.ts). `run` gets whether to keep it.
 */
function RemoveConfirm(who: string, where: string, run: (keepAccount: boolean) => Promise<void>): AdminAction {
  const { t } = i18n()
  return {
    id: 'remove',
    label: t('admin.memberships.remove.label'),
    icon: 'trash',
    tip: '',
    confirm: { ...removeMemberConfirmation(who, where), action: t('admin.memberships.remove.action') },
    run: async keep => run(!!keep),
    done: t('admin.memberships.remove.done', { who, where }),
  }
}

type AddDialogProps = {
  title: string
  submitLabel: string
  /** The picker of the user or workspace; `ready` once something is picked. */
  picker: ReactNode
  ready: boolean
  onAdd: (role: MembershipRole) => Promise<void>
  onClose: () => void
}

function AddDialog({ title, submitLabel, picker, ready, onAdd, onClose }: AddDialogProps) {
  const t = useT()
  const [role, setRole] = useState<MembershipRole>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(role)
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button busy={busy} type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? t('admin.memberships.adding') : submitLabel}
          </Button>
        </>
      }
    >
      {picker}
      <FormField id="adm-add-role" label={t('admin.memberships.role')}>
        <Select
          id="adm-add-role"
          value={role}
          options={roleOptions()}
          label={t('admin.memberships.role')}
          onChange={setRole}
        />
      </FormField>
      {error && <FormMessage>{error}</FormMessage>}
    </Dialog>
  )
}

type UserProps = { user: AdminUser; workspaces: AdminWorkspace[]; notify: Notify; reload: () => Promise<void> }

/** The user's workspaces and pending invitations; Add to workspace adds them directly. */
export function UserWorkspaces({ user: u, workspaces, notify, reload }: UserProps) {
  const t = useT()
  const runner = useActionRunner(notify)
  const change = useChange(notify, reload)
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState('')
  const who = u.name || u.email
  const candidates = workspaces
    .filter(w => !u.workspaces.some(m => m.id === w.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const openAdd = () => {
    setPick(candidates[0]?.id ?? '')
    setAdding(true)
  }
  return (
    <Card
      title={t('admin.memberships.user.title')}
      className="adm-detail"
      actions={
        <Button
          size="sm"
          icon="plus"
          title={
            candidates.length
              ? t('admin.memberships.user.addTo', { who })
              : t('admin.memberships.user.alreadyEverywhere')
          }
          disabled={!candidates.length}
          onClick={openAdd}
        >
          {t('admin.memberships.user.addToWorkspace')}
        </Button>
      }
    >
      <List>
        {u.workspaces.map(w => (
          <MemberRow
            key={w.member_id}
            title={w.name}
            lead="workspace"
            role={w.role}
            removeLabel={t('admin.memberships.user.removeFrom', { workspace: w.name })}
            onRole={role =>
              void change(
                () => runAdmin('membership.setRole', { memberId: w.member_id, role }),
                t('admin.memberships.user.roleChanged', { who, role, workspace: w.name }),
              )
            }
            onRemove={() =>
              runner.pick(
                RemoveConfirm(who, w.name, async keepAccount => {
                  await runAdmin('membership.remove', { memberId: w.member_id, keepAccount })
                  await reload()
                }),
              )
            }
          />
        ))}
        {u.invitations.map(i => (
          <InviteRow
            key={i.id}
            title={i.workspace_name}
            workspace
            sub={t('admin.memberships.user.expires', { date: day(i.expires_at) })}
            role={i.role}
            onResend={() =>
              void change(
                () => runAdmin('invitation.resend', { invitationId: i.id }),
                t('admin.memberships.user.resent', { workspace: i.workspace_name }),
              )
            }
            onRevoke={() =>
              void change(
                () => runAdmin('invitation.revoke', { invitationId: i.id }),
                t('admin.memberships.user.revoked', { workspace: i.workspace_name }),
              )
            }
          />
        ))}
      </List>
      {!u.workspaces.length && !u.invitations.length && <ListEmpty>{t('admin.memberships.user.empty')}</ListEmpty>}
      {adding && (
        <AddDialog
          title={t('admin.memberships.user.addTo', { who })}
          submitLabel={t('admin.memberships.user.add')}
          ready={!!pick}
          onClose={() => setAdding(false)}
          onAdd={async role => {
            const data = await runAdmin('membership.add', { userId: u.id, workspaceId: pick, role })
            await reload()
            notify(
              addedNote(
                who,
                workspaces.find(w => w.id === pick)?.name ?? t('admin.memberships.user.theWorkspace'),
                data,
              ),
            )
          }}
          picker={
            <FormField id="adm-add-ws" label={t('admin.memberships.user.workspace')}>
              <Select
                id="adm-add-ws"
                value={pick}
                options={candidates.map(w => ({ value: w.id, label: w.name }))}
                label={t('admin.memberships.user.workspace')}
                onChange={setPick}
              />
            </FormField>
          }
        />
      )}
      {runner.dialog}
    </Card>
  )
}

/** Users that match the search by name or email, at most `limit`. */
export function matchUsers(users: AdminUser[], query: string, limit = 6): AdminUser[] {
  const q = query.trim().toLowerCase()
  const sorted = [...users].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
  return (q ? sorted.filter(u => `${u.name} ${u.email}`.toLowerCase().includes(q)) : sorted).slice(0, limit)
}

function UserPicker({ users, picked, onPick }: { users: AdminUser[]; picked: string; onPick: (id: string) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const shown = matchUsers(users, query)
  return (
    <FormField id="adm-add-user" label={t('admin.memberships.picker.user')}>
      <Input
        id="adm-add-user"
        type="search"
        value={query}
        placeholder={t('admin.memberships.picker.placeholder')}
        autoComplete="off"
        onChange={e => setQuery(e.target.value)}
      />
      <div className="adm-pick" role="radiogroup" aria-label={t('admin.memberships.picker.user')}>
        {shown.map(u => (
          <button
            key={u.id}
            type="button"
            role="radio"
            aria-checked={u.id === picked}
            className="adm-pick-row"
            onClick={() => onPick(u.id)}
          >
            <Avatar name={u.name || u.email} size={24} src={u.avatar_url} />
            <span className="st-member-t">
              <b>{u.name || u.email}</b>
              <span className="help">{u.email}</span>
            </span>
          </button>
        ))}
        {!shown.length && (
          <p className="help">
            {users.length ? t('admin.memberships.picker.noMatch') : t('admin.memberships.picker.allMembers')}
          </p>
        )}
      </div>
    </FormField>
  )
}

/** Who sent a pending invitation and until when it works. */
function inviteSub(i: WorkspaceMembers['invitations'][number]): string {
  const { t } = i18n()
  if (!i.invited_by)
    return i.expired
      ? t('admin.memberships.workspace.invitedByTeammateExpired')
      : t('admin.memberships.workspace.invitedByTeammate', { date: day(i.expires_at) })
  return i.expired
    ? t('admin.memberships.workspace.invitedByExpired', { inviter: i.invited_by })
    : t('admin.memberships.workspace.invitedBy', { inviter: i.invited_by, date: day(i.expires_at) })
}

type WorkspaceProps = { workspace: AdminWorkspace; users: AdminUser[]; notify: Notify; reload: () => Promise<void> }

/** The workspace's members and pending invitations; Add member adds an existing user directly. */
export function WorkspaceMembersCard({ workspace: w, users, notify, reload }: WorkspaceProps) {
  const t = useT()
  const runner = useActionRunner(notify)
  const [data, setData] = useState<WorkspaceMembers | null>(null)
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState('')
  const load = useCallback(async () => {
    try {
      setData(await loadWorkspaceMembers(w.id))
    } catch (err) {
      notify(errorText(err))
    }
  }, [w.id, notify])
  useEffect(() => void load(), [load])
  const refresh = useCallback(async () => {
    await Promise.all([load(), reload()])
  }, [load, reload])
  const change = useChange(notify, refresh)
  const candidates = users.filter(u => !data?.members.some(m => m.user_id === u.id))
  return (
    <Card
      title={t('admin.memberships.workspace.title')}
      className="adm-detail"
      actions={
        <Button
          size="sm"
          icon="plus"
          title={t('admin.memberships.workspace.addTip')}
          disabled={!data}
          onClick={() => {
            setPick('')
            setAdding(true)
          }}
        >
          {t('admin.memberships.workspace.addMember')}
        </Button>
      }
    >
      {!data && (
        <Loading
          what={t('admin.memberships.workspace.title')}
          loading
          skeleton={<SkeletonList rows={2} aside action />}
        />
      )}
      <List>
        {data?.members.map(m => {
          const name = m.name || m.email
          return (
            <MemberRow
              key={m.member_id}
              title={name}
              sub={m.email}
              lead="person"
              avatarUrl={m.avatar_url}
              role={m.role}
              removeLabel={t('admin.memberships.workspace.remove', { name })}
              onRole={role =>
                void change(
                  () => runAdmin('membership.setRole', { memberId: m.member_id, role }),
                  t('admin.memberships.workspace.roleChanged', { name, role }),
                )
              }
              onRemove={() =>
                runner.pick(
                  RemoveConfirm(name, w.name, async keepAccount => {
                    await runAdmin('membership.remove', { memberId: m.member_id, keepAccount })
                    await refresh()
                  }),
                )
              }
            />
          )
        })}
        {data?.invitations.map(i => (
          <InviteRow
            key={i.id}
            title={i.email}
            sub={inviteSub(i)}
            role={i.role}
            expired={i.expired}
            onResend={() =>
              void change(
                () => runAdmin('invitation.resend', { invitationId: i.id }),
                t('admin.memberships.workspace.resent', { email: i.email }),
              )
            }
            onRevoke={() =>
              void change(
                () => runAdmin('invitation.revoke', { invitationId: i.id }),
                t('admin.memberships.workspace.revoked', { email: i.email }),
              )
            }
          />
        ))}
      </List>
      {data && !data.members.length && !data.invitations.length && (
        <ListEmpty>{t('admin.memberships.workspace.empty')}</ListEmpty>
      )}
      {adding && (
        <AddDialog
          title={t('admin.memberships.workspace.addTitle', { workspace: w.name })}
          submitLabel={t('admin.memberships.workspace.addSubmit')}
          ready={!!pick}
          onClose={() => setAdding(false)}
          onAdd={async role => {
            const data = await runAdmin('membership.add', { userId: pick, workspaceId: w.id, role })
            await refresh()
            const u = users.find(x => x.id === pick)
            notify(addedNote(u?.name || u?.email || t('admin.memberships.workspace.they'), w.name, data))
          }}
          picker={<UserPicker users={candidates} picked={pick} onPick={setPick} />}
        />
      )}
      {runner.dialog}
    </Card>
  )
}
