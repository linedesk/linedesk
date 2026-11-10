// Team: who is in the workspace, with which role, and who is invited. Owners and admins invite,
// change roles and remove; members see the list read-only. Every change is a team.* action.
import { type AssignableRole, assignableRoles, type TeamData, type TeamInvitation, type TeamMember } from '@callfront/actions'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Section } from '../settings/fields.tsx'
import { Avatar, Badge, Button } from '../ui/kit.tsx'
import { teamApi } from './team-api.ts'
import { canEditRole, canRemove, invitationStatus, isEmail, isOnTeam, joinedLabel, roleLabel } from './team-model.ts'

type Run = (work: () => Promise<unknown>, done: string) => Promise<boolean>

function RoleSelect({ value, label, onChange }: { value: AssignableRole; label: string; onChange: (role: AssignableRole) => void }) {
  return (
    <select className="st-select" value={value} aria-label={label} title={label} onChange={e => onChange(e.target.value as AssignableRole)}>
      {assignableRoles.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
    </select>
  )
}

function MemberRow({ data, m, run }: { data: TeamData; m: TeamMember; run: Run }) {
  const [confirming, setConfirming] = useState(false)
  const name = m.name || m.email
  return (
    <div className="st-li st-member">
      <Avatar name={name} size={32} />
      <div className="st-member-t">
        <b>{name}{m.userId === data.me && <Badge>You</Badge>}</b>
        <span className="help">{m.email} · {joinedLabel(m.joinedAt)}</span>
      </div>
      {canEditRole(data, m) && m.role !== 'owner'
        ? <RoleSelect value={m.role} label={`Role for ${name}`} onChange={role => void run(() => teamApi.setRole(m.memberId, role), `${name} is now ${roleLabel(role).toLowerCase()}.`)} />
        : <span className="help st-role">{roleLabel(m.role)}</span>}
      {canRemove(data, m)
        ? <Button size="sm" variant={confirming ? 'danger' : 'ghost'} icon={confirming ? undefined : 'trash'} aria-label={`Remove ${name}`} title={confirming ? 'They lose access at once' : `Remove ${name}`}
            onBlur={() => setConfirming(false)}
            onClick={() => (confirming ? void run(() => teamApi.remove(m.memberId), `${name} removed.`) : setConfirming(true))}>
            {confirming ? 'Remove' : null}
          </Button>
        : data.canManage && <span className="st-rm-space" />}
    </div>
  )
}

function InvitationRow({ invite, canManage, run }: { invite: TeamInvitation; canManage: boolean; run: Run }) {
  return (
    <div className="st-li st-member">
      <Avatar name={invite.email} size={32} />
      <div className="st-member-t">
        <b>{invite.email}<Badge>{invite.expired ? 'Expired' : 'Invited'}</Badge></b>
        <span className="help">Invited by {invite.invitedBy || 'a teammate'} · {invitationStatus(invite)}</span>
      </div>
      <span className="help st-role">{roleLabel(invite.role)}</span>
      {canManage ? (
        <span className="team-inv-actions">
          <Button size="sm" variant="ghost" title="Send the email again; the link works for another 7 days" onClick={() => void run(() => teamApi.resend(invite.invitationId), `Invitation sent again to ${invite.email}.`)}>Resend</Button>
          <Button size="sm" variant="ghost" title="The link stops working" onClick={() => void run(() => teamApi.revoke(invite.invitationId), `Invitation for ${invite.email} revoked.`)}>Revoke</Button>
        </span>
      ) : <span />}
    </div>
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
    if (await run(() => teamApi.invite(address, role), `Invitation sent to ${address}.`)) setEmail('')
  }
  return (
    <form className="st-inline" onSubmit={submit}>
      <label className="k-input"><input type="email" value={email} placeholder="name@business.com" aria-label="Invite by email" onChange={e => setEmail(e.target.value)} /></label>
      <RoleSelect value={role} label="Role for the invited person" onChange={setRole} />
      <Button type="submit" size="sm" variant="primary" disabled={!valid} title="Send the invitation (⏎)">Invite</Button>
    </form>
  )
}

export function TeamPage({ toast }: { toast: (text: string) => void }) {
  const [data, setData] = useState<TeamData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => teamApi.list().then(d => { setData(d); setError(null) }, (e: Error) => setError(e.message)), [])
  useEffect(() => void load(), [load])

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

  if (!data) return <div className="page">{error && <div className="empty"><b>The team could not be loaded</b><span>{error}</span></div>}</div>
  return (
    <div className="page">
      <div className="page-in st-page">
        <div className="page-head"><div><h1>Team</h1><p>Everyone here can open calls and handle the inbox.</p></div></div>
        <Section id="team-members" title="Members" description={data.canManage ? 'Admins can invite people, change roles and remove members. Members see this list.' : 'Only owners and admins can invite people or change roles.'}>
          <div className="st-list">{data.members.map(m => <MemberRow key={m.memberId} data={data} m={m} run={run} />)}</div>
        </Section>
        {(data.canManage || data.invitations.length > 0) && (
          <Section id="team-invites" title="Invitations" description="Invited people join when they open the link in their email. Links work for 7 days.">
            {data.invitations.length > 0 && <div className="st-list">{data.invitations.map(i => <InvitationRow key={i.invitationId} invite={i} canManage={data.canManage} run={run} />)}</div>}
            {data.canManage && <InviteForm data={data} run={run} toast={toast} />}
          </Section>
        )}
      </div>
    </div>
  )
}
