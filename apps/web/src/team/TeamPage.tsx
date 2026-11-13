// Team: who is in the workspace, with which role, and who is invited. Owners and admins invite,
// change roles and remove; members see the list read-only. Every change is a team.* action.
import {
  type AssignableRole,
  assignableRoles,
  type TeamData,
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
  teamRoles,
} from '@linedesk/actions'
import { type FormEvent, useState } from 'react'
import { Section } from '../settings/fields.tsx'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { markLeft } from '../session.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { Select } from '../ui/controls.tsx'
import { Avatar, Badge, Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { teamApi, useTeam } from './team-api.ts'
import {
  canEditRole,
  canRemove,
  invitationStatus,
  isEmail,
  isOnTeam,
  isOwner,
  joinedLabel,
  roleLabel,
} from './team-model.ts'

const roleHelp: Record<TeamRole, string> = {
  owner: 'Also manages owners.',
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

/** Making someone an owner asks once: they can then change or remove every other owner, you included. */
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
      title={`Make ${name} an owner?`}
      description="They can do everything you can, including changing or removing other owners."
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
          <Button type="submit" variant="danger-outline" disabled={busy}>
            {busy ? 'Working…' : 'Make owner'}
          </Button>
        </>
      }
    />
  )
}

function MemberRow({ data, m, run }: { data: TeamData; m: TeamMember; run: Run }) {
  const [confirming, setConfirming] = useState(false)
  const [owning, setOwning] = useState(false)
  const name = m.name || m.email
  const setRole = (role: TeamRole) =>
    run(
      () => teamApi.setRole(m.memberId, role),
      `${m.userId === data.me ? 'You are' : `${name} is`} now ${roleLabel(role).toLowerCase()}.`,
    )
  return (
    <ListRow
      lead={<Avatar name={name} size={24} />}
      title={
        <>
          {name}
          {m.userId === data.me && <Badge>You</Badge>}
        </>
      }
      sub={`${m.email} · ${joinedLabel(m.joinedAt)}`}
      actions={
        <>
          {canEditRole(data, m) ? (
            <RoleSelect
              value={m.role}
              label={`Role for ${name}`}
              roles={isOwner(data) ? teamRoles : assignableRoles}
              onChange={role => (role === 'owner' ? setOwning(true) : void setRole(role))}
            />
          ) : (
            <span className="help st-role">{roleLabel(m.role)}</span>
          )}
          {canRemove(data, m) ? (
            <Button
              size="sm"
              variant={confirming ? 'danger' : 'ghost'}
              icon={confirming ? undefined : 'trash'}
              aria-label={`Remove ${name}`}
              title={confirming ? 'They lose access at once' : `Remove ${name}`}
              onBlur={() => setConfirming(false)}
              onClick={() =>
                confirming ? void run(() => teamApi.remove(m.memberId), `${name} removed.`) : setConfirming(true)
              }
            >
              {confirming ? 'Remove' : null}
            </Button>
          ) : (
            data.canManage && <span className="st-rm-space" />
          )}
        </>
      }
      below={owning && <OwnerConfirm name={name} onConfirm={() => setRole('owner')} onClose={() => setOwning(false)} />}
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
      <Button type="submit" variant="primary" disabled={!valid || sending} title="Send the invitation (⏎)">
        {sending ? 'Sending…' : 'Invite'}
      </Button>
    </form>
  )
}

/** Leave this workspace: confirmed in a dialog; then into another workspace, or to the start without one. */
function LeaveWorkspace({ data }: { data: TeamData }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = data.members.find(m => m.userId === data.me)
  if (!me) return null
  const owners = data.members.filter(m => m.role === 'owner').length
  const lastOwner = me.role === 'owner' && owners < 2
  async function leave(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { nextWorkspaceId } = await teamApi.leave()
      markLeft()
      if (nextWorkspaceId) await switchToWorkspace(nextWorkspaceId)
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
          title={lastOwner ? 'You are the last owner: make someone else owner first' : 'You lose access at once'}
          onClick={() => setAsking(true)}
        >
          Leave workspace…
        </Button>
        {lastOwner && <span className="help">Make someone else owner first.</span>}
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
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? 'Leaving…' : 'Leave workspace'}
              </Button>
            </>
          }
        >
          {error && <FormMessage>{error}</FormMessage>}
        </Dialog>
      )}
    </Section>
  )
}

export function TeamPage({ toast }: { toast: (text: string) => void }) {
  const team = useTeam()
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

  if (!data)
    return (
      <div className="page">
        {error ? (
          <div className="empty">
            <b>The team could not be loaded</b>
            <span>{error}</span>
          </div>
        ) : (
          <div className="page-in st-page" role="status" aria-busy="true" aria-label="Loading the team">
            <Skeleton className="sk-line" />
            <Skeleton className="sk-card" />
          </div>
        )}
      </div>
    )
  return (
    <div className="page">
      <div className="page-in st-page">
        <div className="page-head">
          <div>
            <h1>Team</h1>
          </div>
        </div>
        <Section
          id="team-members"
          title="Members"
          description={data.canManage ? undefined : 'Only owners and admins can invite or change roles.'}
          help="Owners and admins can change settings and invite or remove people. Members work with calls, contacts and appointments but can't change settings."
        >
          <List label="Members">
            {data.members.map(m => (
              <MemberRow key={m.memberId} data={data} m={m} run={run} />
            ))}
          </List>
        </Section>
        {(data.canManage || data.invitations.length > 0) && (
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
        <LeaveWorkspace data={data} />
      </div>
    </div>
  )
}
