// Who belongs where, for an instance admin: a user's workspaces and a workspace's members, each
// with role, remove and pending invitations (resend, revoke), and a dialog to add someone directly.
// Every change is a membership.* or invitation.* action; the server keeps a last owner.
import { type MembershipRole, membershipRoles } from '@linedesk/actions'
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { roleLabel } from '../team/team-model.ts'
import { Select } from '../ui/controls.tsx'
import { Card, Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Avatar, Badge, Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { type AdminAction, useActionRunner } from './actions.tsx'
import { type AdminUser, type AdminWorkspace, loadWorkspaceMembers, runAdmin, type WorkspaceMembers } from './api.ts'
import { errorText, type Notify } from './notify.ts'
import { day } from './parts.tsx'

const roleOptions = membershipRoles.map(r => ({ value: r, label: roleLabel(r) }))
const asRole = (role: string): MembershipRole => (membershipRoles.includes(role as MembershipRole) ? (role as MembershipRole) : 'member')

/** What Add to workspace did: a confirmed address joins at once, an unconfirmed one is invited (membership.add). */
export const addedNote = (who: string, where: string, data: { joined?: unknown }) =>
  data.joined === 'invited'
    ? `${who} was invited to ${where}. They join once they confirm their email address.`
    : `${who} was added to ${where}.`

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
  role: string
  /** Why the role and remove are locked (the last owner), or undefined. */
  locked?: string
  onRole: (role: MembershipRole) => void
  onRemove: () => void
  removeLabel: string
}

function MemberRow({ title, sub, role, locked, onRole, onRemove, removeLabel }: MemberRowProps) {
  return (
    <ListRow
      lead={<Avatar name={title} size={24} />}
      title={title}
      sub={sub}
      actions={
        <>
          {locked ? (
            <span className="help st-role" title={locked}>
              {roleLabel(role)}
            </span>
          ) : (
            <Select size="sm" align="end" value={asRole(role)} options={roleOptions} label={`Role in ${title}`} onChange={onRole} />
          )}
          <Button size="sm" variant="ghost" icon="trash" aria-label={removeLabel} title={locked ?? removeLabel} disabled={!!locked} onClick={onRemove} />
        </>
      }
    />
  )
}

type InviteRowProps = { title: string; sub: string; role: string; expired?: boolean; onResend: () => void; onRevoke: () => void }

function InviteRow({ title, sub, role, expired, onResend, onRevoke }: InviteRowProps) {
  const [confirming, setConfirming] = useState(false)
  return (
    <ListRow
      lead={<Avatar name={title} size={24} />}
      title={
        <>
          {title}
          <Badge>{expired ? 'Expired' : 'Invited'}</Badge>
        </>
      }
      sub={sub}
      aside={roleLabel(role)}
      actions={
      <span className="team-inv-actions">
        <Button size="sm" variant="ghost" title="Send the email again; the link works for another 7 days" onClick={onResend}>
          Resend
        </Button>
        <Button
          size="sm"
          variant={confirming ? 'danger' : 'ghost'}
          title={confirming ? 'Click again to revoke. The invitation link stops working.' : 'Revoke the invitation; its link stops working'}
          onBlur={() => setConfirming(false)}
          onClick={() => (confirming ? onRevoke() : setConfirming(true))}
        >
          {confirming ? 'Revoke invitation' : 'Revoke'}
        </Button>
      </span>
      }
    />
  )
}

function RemoveConfirm(who: string, where: string, run: () => Promise<void>): AdminAction {
  return {
    id: 'remove',
    label: 'Remove…',
    icon: 'trash',
    tip: '',
    confirm: { text: `${who} loses access to ${where} at once.`, action: 'Remove from workspace' },
    run,
    done: `${who} was removed from ${where}.`,
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
            Cancel
          </Button>
          <Button busy={busy} type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? 'Adding…' : submitLabel}
          </Button>
        </>
      }
    >
      {picker}
      <FormField id="adm-add-role" label="Role">
        <Select id="adm-add-role" value={role} options={roleOptions} label="Role" onChange={setRole} />
      </FormField>
      {error && <FormMessage>{error}</FormMessage>}
    </Dialog>
  )
}

type UserProps = { user: AdminUser; workspaces: AdminWorkspace[]; notify: Notify; reload: () => Promise<void> }

/** The user's workspaces and pending invitations; Add to workspace adds them directly. */
export function UserWorkspaces({ user: u, workspaces, notify, reload }: UserProps) {
  const runner = useActionRunner(notify)
  const change = useChange(notify, reload)
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState('')
  const who = u.name || u.email
  const candidates = workspaces.filter(w => !u.workspaces.some(m => m.id === w.id)).sort((a, b) => a.name.localeCompare(b.name))
  const openAdd = () => {
    setPick(candidates[0]?.id ?? '')
    setAdding(true)
  }
  return (
    <Card
      title="Workspaces"
      className="adm-detail"
      actions={
        <Button size="sm" icon="plus" title={candidates.length ? `Add ${who} to a workspace` : 'Already in every workspace'} disabled={!candidates.length} onClick={openAdd}>
          Add to workspace…
        </Button>
      }
    >
      <List>
        {u.workspaces.map(w => (
          <MemberRow
            key={w.member_id}
            title={w.name}
            role={w.role}
            removeLabel={`Remove from ${w.name}`}
            onRole={role => void change(() => runAdmin('membership.setRole', { memberId: w.member_id, role }), `${who} is now ${role} of ${w.name}.`)}
            onRemove={() => runner.pick(RemoveConfirm(who, w.name, async () => { await runAdmin('membership.remove', { memberId: w.member_id }); await reload() }))}
          />
        ))}
        {u.invitations.map(i => (
          <InviteRow
            key={i.id}
            title={i.workspace_name}
            sub={`Expires ${day(i.expires_at)}`}
            role={i.role}
            onResend={() => void change(() => runAdmin('invitation.resend', { invitationId: i.id }), `Invitation to ${i.workspace_name} sent again.`)}
            onRevoke={() => void change(() => runAdmin('invitation.revoke', { invitationId: i.id }), `Invitation to ${i.workspace_name} revoked.`)}
          />
        ))}
      </List>
      {!u.workspaces.length && !u.invitations.length && <ListEmpty>No workspaces.</ListEmpty>}
      {adding && (
        <AddDialog
          title={`Add ${who} to a workspace`}
          submitLabel="Add"
          ready={!!pick}
          onClose={() => setAdding(false)}
          onAdd={async role => {
            const data = await runAdmin('membership.add', { userId: u.id, workspaceId: pick, role })
            await reload()
            notify(addedNote(who, workspaces.find(w => w.id === pick)?.name ?? 'the workspace', data))
          }}
          picker={
            <FormField id="adm-add-ws" label="Workspace">
              <Select id="adm-add-ws" value={pick} options={candidates.map(w => ({ value: w.id, label: w.name }))} label="Workspace" onChange={setPick} />
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
  const [query, setQuery] = useState('')
  const shown = matchUsers(users, query)
  return (
    <FormField id="adm-add-user" label="User">
      <Input id="adm-add-user" type="search" value={query} placeholder="Name or email" autoComplete="off" onChange={e => setQuery(e.target.value)} />
      <div className="adm-pick" role="radiogroup" aria-label="User">
        {shown.map(u => (
          <button key={u.id} type="button" role="radio" aria-checked={u.id === picked} className="adm-pick-row" onClick={() => onPick(u.id)}>
            <Avatar name={u.name || u.email} size={24} />
            <span className="st-member-t">
              <b>{u.name || u.email}</b>
              <span className="help">{u.email}</span>
            </span>
          </button>
        ))}
        {!shown.length && <p className="help">{users.length ? 'Nobody matches.' : 'Every user is already a member.'}</p>}
      </div>
    </FormField>
  )
}

type WorkspaceProps = { workspace: AdminWorkspace; users: AdminUser[]; notify: Notify; reload: () => Promise<void> }

/** The workspace's members and pending invitations; Add member adds an existing user directly. */
export function WorkspaceMembersCard({ workspace: w, users, notify, reload }: WorkspaceProps) {
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
  const owners = data?.members.filter(m => m.role === 'owner').length ?? 0
  const candidates = users.filter(u => !data?.members.some(m => m.user_id === u.id))
  return (
    <Card
      title="Members"
      className="adm-detail"
      actions={
        <Button size="sm" icon="plus" title="Add an existing user" disabled={!data} onClick={() => { setPick(''); setAdding(true) }}>
          Add member…
        </Button>
      }
    >
      {!data && <Loading what="Members" loading skeleton={<SkeletonList rows={2} aside action />} />}
      <List>
        {data?.members.map(m => {
          const name = m.name || m.email
          return (
            <MemberRow
              key={m.member_id}
              title={name}
              sub={m.email}
              role={m.role}
              locked={m.role === 'owner' && owners < 2 ? 'The last owner: make someone else owner first' : undefined}
              removeLabel={`Remove ${name}`}
              onRole={role => void change(() => runAdmin('membership.setRole', { memberId: m.member_id, role }), `${name} is now ${role}.`)}
              onRemove={() => runner.pick(RemoveConfirm(name, w.name, async () => { await runAdmin('membership.remove', { memberId: m.member_id }); await refresh() }))}
            />
          )
        })}
        {data?.invitations.map(i => (
          <InviteRow
            key={i.id}
            title={i.email}
            sub={`Invited by ${i.invited_by || 'a teammate'} · ${i.expired ? 'expired' : `expires ${day(i.expires_at)}`}`}
            role={i.role}
            expired={i.expired}
            onResend={() => void change(() => runAdmin('invitation.resend', { invitationId: i.id }), `Invitation sent again to ${i.email}.`)}
            onRevoke={() => void change(() => runAdmin('invitation.revoke', { invitationId: i.id }), `Invitation for ${i.email} revoked.`)}
          />
        ))}
      </List>
      {data && !data.members.length && !data.invitations.length && <ListEmpty>No members.</ListEmpty>}
      {adding && (
        <AddDialog
          title={`Add a member to ${w.name}`}
          submitLabel="Add member"
          ready={!!pick}
          onClose={() => setAdding(false)}
          onAdd={async role => {
            const data = await runAdmin('membership.add', { userId: pick, workspaceId: w.id, role })
            await refresh()
            const u = users.find(x => x.id === pick)
            notify(addedNote(u?.name || u?.email || 'They', w.name, data))
          }}
          picker={<UserPicker users={candidates} picked={pick} onPick={setPick} />}
        />
      )}
      {runner.dialog}
    </Card>
  )
}
