// Workspace settings › Team: who is in the workspace, with which role, and who is invited. Owners and admins
// invite, change roles and remove, and edit a teammate's profile and notifications (MemberEdit.tsx); members see
// the list read-only. Every change is a team.* action. Leaving the
// workspace (LeaveWorkspace) is in the Danger zone section.
import {
  type AssignableRole,
  assignableRoles,
  type TeamData,
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
} from '@linedesk/actions'
import { type FormEvent, useEffect, useState } from 'react'
import { Section } from '../settings/fields.tsx'
import { ONLY_ADMINS } from '../settings/readOnly.ts'
import { NotificationDefaults } from '../settings/Notifications.tsx'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { signOutAndForget } from '../localData.ts'
import { markLeft } from '../session.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { useWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Avatar, Badge, Button } from '../ui/kit.tsx'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { sectionParts } from '../ui/SettingsLayout.tsx'
import { teamApi, useTeam } from './team-api.ts'
import { MemberEditDialog } from './MemberEdit.tsx'
import {
  canEditMember,
  canEditRole,
  canRemove,
  invitationStatus,
  isEmail,
  isMe,
  isOnTeam,
  joinedLabel,
  PROFILE_HASH,
  removeMemberConfirmation,
  roleLabel,
  rolesFor,
} from './team-model.ts'

const roleHelp: Record<TeamRole, string> = {
  owner: 'Hand the workspace over: you become an admin.',
  admin: 'Settings and people.',
  member: 'Calls and contacts.',
}

type Run = (work: () => Promise<unknown>, done: string) => Promise<boolean>

function RoleSelect<R extends TeamRole>({
  id,
  value,
  label,
  onChange,
  roles,
  size = 'sm',
}: {
  id?: string
  size?: 'sm' | 'md'
  value: R
  label: string
  onChange: (role: R) => void
  roles: readonly R[]
}) {
  return (
    <Select
      id={id}
      size={size}
      align="end"
      value={value}
      label={label}
      onChange={onChange}
      options={roles.map(r => ({ value: r, label: roleLabel(r), description: roleHelp[r] }))}
    />
  )
}

/** Handing the workspace over asks once: there is one owner, and it is not you afterwards. */
function OwnerConfirm({
  name,
  onConfirm,
  onClose,
}: {
  name: string
  onConfirm: () => Promise<boolean>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      title={`Make ${name} the owner?`}
      description="A workspace has one owner, who can also delete it or hand it over. You become an admin and keep every setting and the team."
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={async e => {
        e.preventDefault()
        setBusy(true)
        await onConfirm()
        onClose()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button busy={busy} type="submit" variant="danger-outline" disabled={busy}>
            Make owner
          </Button>
        </>
      }
    />
  )
}

function MemberRow({ data, m, run, onEdit }: { data: TeamData; m: TeamMember; run: Run; onEdit: () => void }) {
  const [removing, setRemoving] = useState(false)
  const [owning, setOwning] = useState(false)
  const name = m.name || m.email
  const setRole = (role: AssignableRole) =>
    run(() => teamApi.setRole(m.memberId, role), `${name} is now ${roleLabel(role).toLowerCase()}.`)
  const transfer = () => run(() => teamApi.transferOwnership(m.memberId), `${name} is now the owner. You are an admin.`)
  return (
    <ListRow
      lead={<Avatar name={name} size={24} src={m.avatarUrl} />}
      title={
        <>
          {name}
          {m.userId === data.me && <Badge>You</Badge>}
        </>
      }
      sub={`${m.email} · ${joinedLabel(m.joinedAt)}`}
      actions={
        <>
          {isMe(data, m) && (
            <Button
              size="sm"
              variant="ghost"
              title="Your name, sign-in and sessions, in Account"
              onClick={() => {
                window.location.hash = PROFILE_HASH
              }}
            >
              Edit profile
            </Button>
          )}
          {canEditMember(data, m) && (
            <Button size="sm" variant="ghost" title={`${name}'s name, picture and notifications`} onClick={onEdit}>
              Edit
            </Button>
          )}
          {canEditRole(data, m) ? (
            <RoleSelect
              value={m.role}
              label={`Role for ${name}`}
              roles={rolesFor(data)}
              onChange={role => (role === 'owner' ? setOwning(true) : void setRole(role))}
            />
          ) : (
            <span className="help st-role">{roleLabel(m.role)}</span>
          )}
          {canRemove(data, m) ? (
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={() => setRemoving(true)}
            />
          ) : (
            data.canManage && <span className="st-rm-space" />
          )}
        </>
      }
      below={
        <>
          {owning && <OwnerConfirm name={name} onConfirm={transfer} onClose={() => setOwning(false)} />}
          {removing && (
            <DangerConfirmDialog
              confirm={removeMemberConfirmation(name)}
              run={async keepAccount => {
                if (await run(() => teamApi.remove(m.memberId, keepAccount), `${name} removed.`)) setRemoving(false)
              }}
              onClose={() => setRemoving(false)}
            />
          )}
        </>
      }
    />
  )
}

function InvitationRow({ invite, canManage, run }: { invite: TeamInvitation; canManage: boolean; run: Run }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <ListRow
      lead={<Avatar name={invite.email} size={24} />}
      title={
        <>
          <span className="k-row-text">{invite.email}</span>
          <Badge>{invite.expired ? 'Expired' : 'Invited'}</Badge>
        </>
      }
      sub={<span title={`Invited by ${invite.invitedBy || 'a teammate'}`}>{invitationStatus(invite)}</span>}
      aside={roleLabel(invite.role)}
      actions={
        canManage && (
          <span className="team-inv-actions">
            <Button
              size="sm"
              variant="ghost"
              title="Send the email again; the link works for another 7 days"
              onClick={() =>
                void run(() => teamApi.resend(invite.invitationId), `Invitation sent again to ${invite.email}.`)
              }
            >
              Resend
            </Button>
            <Button
              size="sm"
              variant={confirming ? 'danger' : 'ghost'}
              title={confirming ? 'Click again: the link stops working' : 'The link stops working'}
              onBlur={() => setConfirming(false)}
              onClick={() =>
                confirming
                  ? void run(() => teamApi.revoke(invite.invitationId), `Invitation for ${invite.email} revoked.`)
                  : setConfirming(true)
              }
            >
              {confirming ? 'Revoke invitation' : 'Revoke'}
            </Button>
          </span>
        )
      }
    />
  )
}

function InviteForm({ data, run, toast }: { data: TeamData; run: Run; toast: (text: string) => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AssignableRole>('member')
  const valid = isEmail(email)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    if (!valid) return
    if (isOnTeam(data, address)) return toast(`${address} is already on the team or invited.`)
    if (await run(() => teamApi.invite(address, role), `Invitation sent to ${address}.`)) {
      setEmail('')
      setRole('member') // the next invitation starts with the least access again
    }
  }
  const [sending, setSending] = useState(false)
  // Invite people… in the workspace menu (`#workspace/team/invite`): the address field takes focus.
  useEffect(() => {
    const focus = () => {
      if (sectionParts('workspace', window.location.hash).item === 'invite')
        document.getElementById('team-invite-email')?.focus()
    }
    focus()
    window.addEventListener('hashchange', focus)
    return () => window.removeEventListener('hashchange', focus)
  }, [])
  return (
    <form
      className="team-invite"
      onSubmit={e => {
        setSending(true)
        void submit(e).finally(() => setSending(false))
      }}
    >
      <FormField id="team-invite-email" label="Invite by email" className="team-invite-email">
        <Input
          id="team-invite-email"
          type="email"
          value={email}
          placeholder="name@business.com"
          autoComplete="off"
          onChange={e => setEmail(e.target.value)}
        />
      </FormField>
      <FormField id="team-invite-role" label="Role">
        <RoleSelect
          id="team-invite-role"
          size="md"
          value={role}
          label="Role for the invited person"
          roles={assignableRoles}
          onChange={setRole}
        />
      </FormField>
      <Button
        busy={sending}
        type="submit"
        variant="primary"
        disabled={!valid || sending}
        title="Send the invitation (⏎)"
      >
        {sending ? 'Sending…' : 'Invite'}
      </Button>
    </form>
  )
}

/**
 * Leave this workspace: confirmed in a dialog; then into another workspace, or to the start without one. When it is
 * the person's only workspace the dialog asks "Also delete my account", ticked by default (never for a server admin,
 * whose account stays; the server checks both again).
 */
export function LeaveWorkspace({ data, isInstanceAdmin }: { data: TeamData; isInstanceAdmin: boolean }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteAccount, setDeleteAccount] = useState(true)
  const workspaces = useWorkspaces()
  const me = data.members.find(m => m.userId === data.me)
  if (!me) return null
  // The one owner hands the workspace over before leaving it (or deletes it).
  const lastOwner = me.role === 'owner'
  const lastWorkspace = !isInstanceAdmin && workspaces !== null && workspaces.length <= 1
  async function leave(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { nextWorkspaceId, accountDeleted } = await teamApi.leave(lastWorkspace && deleteAccount)
      markLeft()
      if (accountDeleted) {
        // The account and its sessions are gone: forget what this browser kept, then the sign-in page.
        await signOutAndForget().catch(() => {})
        window.location.replace('/')
      } else if (nextWorkspaceId) await switchToWorkspace(nextWorkspaceId)
      else window.location.replace('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <Section id="team-leave" title="Leave workspace">
      <div className="team-leave">
        <Button
          variant="danger-outline"
          disabled={lastOwner}
          title={lastOwner ? 'You are the owner: make someone else the owner first' : 'You lose access at once'}
          onClick={() => setAsking(true)}
        >
          Leave workspace…
        </Button>
        {lastOwner && <span className="help">You are the owner. Make someone else the owner first (Team).</span>}
      </div>
      {asking && (
        <Dialog
          title="Leave workspace"
          description="You lose access at once. Only a new invitation brings you back."
          size="sm"
          onClose={busy ? () => {} : () => setAsking(false)}
          onSubmit={leave}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Button>
              <Button busy={busy} type="submit" variant="danger" disabled={busy}>
                {busy ? 'Leaving…' : 'Leave workspace'}
              </Button>
            </>
          }
        >
          {lastWorkspace && (
            <Checkbox checked={deleteAccount} onChange={setDeleteAccount} disabled={busy}>
              Also delete my account (this is your only workspace)
            </Checkbox>
          )}
          {error && <FormMessage>{error}</FormMessage>}
        </Dialog>
      )}
    </Section>
  )
}

/** The team section of Workspace settings; the team defaults for notifications at its end (owners and admins). */
export function TeamSection({ toast }: { toast: (text: string) => void }) {
  const team = useTeam()
  const [editing, setEditing] = useState<TeamMember | null>(null)
  const data = team.data ?? null
  const error = data ? null : team.error
  const load = team.reload

  const run: Run = async (work, done) => {
    try {
      await work()
      toast(done)
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      await load()
    }
  }

  return (
    <>
      <Section
        id="team-members"
        title="Members"
        description={data && !data.canManage ? ONLY_ADMINS : undefined}
        help="The owner can do everything an admin can, and also delete the workspace or hand it over (one owner per workspace). Admins change settings, invite or remove people, and edit a teammate's name, picture and notifications (not the owner's). Members work with calls, contacts and reminders but can't change settings."
      >
        <Loading
          what="The team"
          loading={!data}
          error={error}
          onRetry={() => void load()}
          skeleton={<SkeletonList rows={2} lead={24} aside />}
        >
          {data && (
            <List label="Members">
              {data.members.map(m => (
                <MemberRow key={m.memberId} data={data} m={m} run={run} onEdit={() => setEditing(m)} />
              ))}
            </List>
          )}
        </Loading>
        {editing && (
          <MemberEditDialog
            memberId={editing.memberId}
            name={editing.name || editing.email}
            onClose={() => setEditing(null)}
            toast={toast}
          />
        )}
      </Section>
      {data && (data.canManage || data.invitations.length > 0) && (
        <Section id="team-invites" title="Invitations" description="Links in the email work for 7 days.">
          {data.invitations.length === 0 && <ListEmpty>No pending invitations.</ListEmpty>}
          {data.invitations.length > 0 && (
            <List label="Invitations">
              {data.invitations.map(i => (
                <InvitationRow key={i.invitationId} invite={i} canManage={data.canManage} run={run} />
              ))}
            </List>
          )}
          {data.canManage && <InviteForm data={data} run={run} toast={toast} />}
        </Section>
      )}
      <NotificationDefaults toast={toast} />
    </>
  )
}
