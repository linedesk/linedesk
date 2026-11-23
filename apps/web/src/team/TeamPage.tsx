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
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { ReadOnlyNote, Section } from '../settings/fields.tsx'
import { useSupportAccess } from '../supportAccess.ts'
import { NotificationDefaults } from '../settings/Notifications.tsx'
import { Dialog, FormMessage, Input } from '../ui/form.tsx'
import { NO_PASSWORD_MANAGER } from '../ui/passwordManager.ts'
import { signInAgain, signOutAndForget } from '../localData.ts'
import { markLeft } from '../session.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { useWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { appLink } from '../ui/AppLink.tsx'
import { Avatar, Badge, Button, Note } from '../ui/kit.tsx'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { List, ListRow, MenuButton, type MenuItem } from '../ui/list.tsx'
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
  isOwner,
  joinedLabel,
  membersInOrder,
  sentInvitations,
  PROFILE_HASH,
  roleLabel,
  rolesFor,
  needsSignInAgain,
  type TeamRun,
  teamRemoveConfirmation,
  teamAsShown,
  teamRunner,
} from './team-model.ts'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'

const roleHelp = {
  owner: msg('team.role.ownerHelp'),
  admin: msg('team.role.adminHelp'),
  member: msg('team.role.memberHelp'),
} satisfies Record<TeamRole, MessageKey>

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
  const t = useT()
  return (
    <Select
      id={id}
      size={size}
      align="end"
      value={value}
      label={label}
      onChange={onChange}
      options={roles.map(r => ({ value: r, label: roleLabel(r), description: t(roleHelp[r]) }))}
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
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      title={t('team.owner.title', { name })}
      description={t('team.owner.description')}
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
            {t('common.action.cancel')}
          </Button>
          <Button busy={busy} type="submit" variant="danger-outline" disabled={busy}>
            {t('team.owner.make')}
          </Button>
        </>
      }
    />
  )
}

/**
 * One row action pattern for members and invitations (UI cleanup S6): the role, then a ⋯ menu with what can be done to
 * the row (Edit profile, Edit, Remove; Resend, Revoke). A row with nothing to do keeps the menu's room, so the roles
 * line up.
 */
function RowMenu({ name, items }: { name: string; items: MenuItem[] }) {
  const t = useT()
  if (!items.length) return <span className="team-menu-space" />
  return <MenuButton title={t('settings.team.rowActions', { name })} items={items} />
}

function MemberRow({ data, m, run, onEdit }: { data: TeamData; m: TeamMember; run: TeamRun; onEdit: () => void }) {
  const t = useT()
  const [removing, setRemoving] = useState(false)
  // Deleting their account needs a recent sign-in: the dialog then offers "Sign in again" (LIN-264 review F3).
  const [signInFirst, setSignInFirst] = useState(false)
  const [owning, setOwning] = useState(false)
  const name = m.name || m.email
  const setRole = (role: AssignableRole) =>
    run(() => teamApi.setRole(m.memberId, role), t('team.member.roleChanged', { name, role }))
  const transfer = () => run(() => teamApi.transferOwnership(m.memberId), t('team.owner.done', { name }))
  return (
    <ListRow
      lead={<Avatar name={name} size={24} src={m.avatarUrl} />}
      title={
        <>
          {name}
          {m.userId === data.me && <Badge>{t('team.member.you')}</Badge>}
          {m.partner && (
            <Badge tone="outline" title={t('team.member.partnerTip', { partner: m.partner })}>
              {m.partner}
            </Badge>
          )}
        </>
      }
      sub={t('team.member.sub', { email: m.email, joined: joinedLabel(m.joinedAt) })}
      actions={
        <>
          <span className="team-role">
            {canEditRole(data, m) ? (
              <RoleSelect
                value={m.role}
                label={t('team.member.roleFor', { name })}
                roles={rolesFor(data)}
                onChange={role => (role === 'owner' ? setOwning(true) : void setRole(role))}
              />
            ) : (
              <span className="help st-role">{roleLabel(m.role)}</span>
            )}
          </span>
          <RowMenu
            name={name}
            items={[
              ...(isMe(data, m)
                ? [
                    {
                      id: 'profile',
                      label: t('team.member.editProfile'),
                      title: t('team.member.editProfileTitle'),
                      onSelect: () => {
                        window.location.hash = PROFILE_HASH
                      },
                    },
                  ]
                : []),
              ...(canEditMember(data, m)
                ? [
                    {
                      id: 'edit',
                      label: t('team.member.edit'),
                      title: t('team.member.editTitle', { name }),
                      onSelect: onEdit,
                    },
                  ]
                : []),
              ...(canRemove(data, m)
                ? [
                    {
                      id: 'remove',
                      label: t('team.member.remove', { name }),
                      danger: true,
                      onSelect: () => setRemoving(true),
                    },
                  ]
                : []),
            ]}
          />
        </>
      }
      below={
        <>
          {owning && <OwnerConfirm name={name} onConfirm={transfer} onClose={() => setOwning(false)} />}
          {removing && (
            <DangerConfirmDialog
              confirm={teamRemoveConfirmation(name, isOwner(data), sentInvitations(data, m.userId))}
              run={async deleteAccount => {
                setSignInFirst(false)
                const remove = () =>
                  teamApi.remove(m.memberId, deleteAccount).catch((err: unknown) => {
                    // Deleting their account needs a sign-in in the last 10 minutes: the note below offers it.
                    if (needsSignInAgain(err)) setSignInFirst(true)
                    throw err
                  })
                // A refusal is thrown to the dialog: it shows why and stays usable.
                await run(remove, t('team.member.removed', { name }), { inDialog: true })
                setRemoving(false)
              }}
              explains={needsSignInAgain}
              onClose={() => {
                setSignInFirst(false)
                setRemoving(false)
              }}
            >
              {deleteAccount =>
                signInFirst &&
                deleteAccount && (
                  <Note
                    tone="warning"
                    title={t('team.remove.signInFirst.title')}
                    action={
                      <Button size="sm" title={t('account.signInAgain.title')} onClick={() => void signInAgain()}>
                        {t('account.signInAgain.button')}
                      </Button>
                    }
                  >
                    {t('team.remove.signInFirst.text')}
                  </Note>
                )
              }
            </DangerConfirmDialog>
          )}
        </>
      }
    />
  )
}

function InvitationRow({ invite, canManage, run }: { invite: TeamInvitation; canManage: boolean; run: TeamRun }) {
  const t = useT()
  // Revoke can't be undone (the link stops working): the menu's Revoke turns the menu into "Revoke invitation", and a
  // second click does it; leaving the button puts the menu back.
  const [confirming, setConfirming] = useState(false)
  const revoke = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) revoke.current?.focus()
  }, [confirming])
  return (
    <ListRow
      lead={<Avatar name={invite.email} size={24} />}
      title={
        <>
          <span className="k-row-text">{invite.email}</span>
          <Badge>{invite.expired ? t('team.invitation.expired') : t('team.invitation.invited')}</Badge>
        </>
      }
      sub={
        <span title={t('team.invitation.invitedBy', { name: invite.invitedBy || t('team.invitation.aTeammate') })}>
          {invitationStatus(invite)}
        </span>
      }
      actions={
        <>
          {/* The role where a member's role is, as plain text: an invitation's role is set when it is sent. */}
          <span className="team-role">
            <span className="help st-role">{roleLabel(invite.role)}</span>
          </span>
          {confirming ? (
            <Button
              ref={revoke}
              size="sm"
              variant="danger"
              title={t('team.invitation.revokeConfirmTitle')}
              onBlur={() => setConfirming(false)}
              onClick={() =>
                void run(
                  () => teamApi.revoke(invite.invitationId),
                  t('team.invitation.revoked', { email: invite.email }),
                )
              }
            >
              {t('team.invitation.revokeConfirm')}
            </Button>
          ) : (
            <RowMenu
              name={invite.email}
              items={
                canManage
                  ? [
                      {
                        id: 'resend',
                        label: t('team.invitation.resend'),
                        title: t('team.invitation.resendTitle'),
                        onSelect: () =>
                          void run(
                            () => teamApi.resend(invite.invitationId),
                            t('team.invitation.resent', { email: invite.email }),
                          ),
                      },
                      {
                        id: 'revoke',
                        label: t('team.invitation.revoke'),
                        title: t('team.invitation.revokeTitle'),
                        danger: true,
                        onSelect: () => setConfirming(true),
                      },
                    ]
                  : []
              }
            />
          )}
        </>
      }
    />
  )
}

function InviteForm({ data, run, toast }: { data: TeamData; run: TeamRun; toast: (text: string) => void }) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AssignableRole>('member')
  const valid = isEmail(email)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    if (!valid) return
    if (isOnTeam(data, address)) return toast(t('team.invite.alreadyOnTeam', { email: address }))
    if (await run(() => teamApi.invite(address, role), t('team.invite.sent', { email: address }))) {
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
      <Input
        id="team-invite-email"
        className="team-invite-email"
        type="email"
        value={email}
        aria-label={t('team.invite.byEmail')}
        placeholder={t('team.invite.placeholder')}
        {...NO_PASSWORD_MANAGER}
        onChange={e => setEmail(e.target.value)}
      />
      <RoleSelect
        id="team-invite-role"
        size="md"
        value={role}
        label={t('team.invite.roleLabel')}
        roles={assignableRoles}
        onChange={setRole}
      />
      <Button
        busy={sending}
        type="submit"
        variant="primary"
        disabled={!valid || sending}
        title={t('common.withKey', { label: t('team.invite.sendTitle'), key: '⏎' })}
      >
        {sending ? t('team.invite.sending') : t('team.invite.button')}
      </Button>
    </form>
  )
}

/**
 * Leave this workspace: confirmed in a dialog; then into another workspace, or to the start without one. When it is
 * the person's only workspace the dialog asks "Also delete my account", ticked by default (never for a server admin,
 * whose account stays; the server checks both again). Deleting the account needs a sign-in in the last 10 minutes:
 * otherwise the dialog offers "Sign in again", which comes back to this page.
 */
export function LeaveWorkspace({ data, isInstanceAdmin }: { data: TeamData; isInstanceAdmin: boolean }) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteAccount, setDeleteAccount] = useState(true)
  // Deleting the account needs a sign-in in the last 10 minutes (the server's SIGN_IN_AGAIN).
  const [signInFirst, setSignInFirst] = useState(false)
  // Leave had the focus and was disabled while it ran: after a refusal the focus goes back into the dialog (Esc, Tab).
  const [failures, setFailures] = useState(0)
  const leaveButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (failures > 0) leaveButton.current?.focus()
  }, [failures])
  const workspaces = useWorkspaces()
  const me = data.members.find(m => m.userId === data.me)
  if (!me) return null
  // Here through the workspace's partner: the membership comes and goes with the partner's team, never on its own
  // (the API refuses it, partner_managed), so there is no Leave to offer.
  if (me.partner)
    return (
      <Section id="team-leave" title={t('team.leave.title')}>
        <span className="help">
          <T k="team.leave.viaPartner" values={{ partner: me.partner, link: appLink('#partner') }} />
        </span>
      </Section>
    )
  // The one owner hands the workspace over before leaving it (or deletes it).
  const lastOwner = me.role === 'owner'
  const lastWorkspace = !isInstanceAdmin && workspaces !== null && workspaces.length <= 1
  // Until the workspace list is known, "is this my last workspace" is not: a leave then would keep the account silently.
  const loadingWorkspaces = workspaces === null
  async function leave(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { nextWorkspaceId, accountDeleted } = await teamApi.leave(lastWorkspace && deleteAccount)
      markLeft({ accountDeleted })
      if (accountDeleted) {
        // The account and its sessions are gone: forget what this browser kept, then the sign-in page.
        await signOutAndForget().catch(() => {})
        window.location.replace('/')
      } else if (nextWorkspaceId) await switchToWorkspace(nextWorkspaceId)
      else window.location.replace('/')
    } catch (err) {
      const signIn = needsSignInAgain(err)
      setSignInFirst(signIn)
      setError(signIn ? null : err instanceof Error ? err.message : String(err))
      setBusy(false)
      setFailures(n => n + 1)
    }
  }
  return (
    <Section id="team-leave" title={t('team.leave.title')}>
      <div className="team-leave">
        <Button
          variant="danger-outline"
          disabled={lastOwner || loadingWorkspaces}
          title={lastOwner ? t('team.leave.ownerTitle') : t('team.leave.loseAccess')}
          onClick={() => setAsking(true)}
        >
          {t('team.leave.button')}
        </Button>
        {lastOwner && (
          <span className="help">
            <T k="team.leave.ownerHelp" values={{ link: appLink('#workspace/team') }} />
          </span>
        )}
      </div>
      {asking && (
        <Dialog
          title={t('team.leave.title')}
          description={t('team.leave.description')}
          size="sm"
          onClose={busy ? () => {} : () => setAsking(false)}
          onSubmit={leave}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
                {t('common.action.cancel')}
              </Button>
              <Button ref={leaveButton} busy={busy} type="submit" variant="danger" disabled={busy}>
                {busy ? t('team.leave.leaving') : t('team.leave.title')}
              </Button>
            </>
          }
        >
          {lastWorkspace && (
            <Checkbox checked={deleteAccount} onChange={setDeleteAccount} disabled={busy}>
              {t('team.leave.deleteAccount')}
            </Checkbox>
          )}
          {signInFirst && lastWorkspace && deleteAccount && (
            <Note
              tone="warning"
              title={t('team.leave.signInFirst.title')}
              action={
                <Button size="sm" title={t('account.signInAgain.title')} onClick={() => void signInAgain()}>
                  {t('account.signInAgain.button')}
                </Button>
              }
            >
              {t('team.leave.signInFirst.text')}
            </Note>
          )}
          {error && <FormMessage>{error}</FormMessage>}
        </Dialog>
      )}
    </Section>
  )
}

/** The team section of Workspace settings; the team defaults for notifications at its end (owners and admins). */
export function TeamSection({ toast }: { toast: (text: string) => void }) {
  const t = useT()
  const team = useTeam()
  const supportAccess = useSupportAccess()
  const [editing, setEditing] = useState<TeamMember | null>(null)
  const data = teamAsShown(team.data ?? null, supportAccess)
  const error = data ? null : team.error
  const load = team.reload

  const run = teamRunner(toast, load)

  return (
    <>
      <Section id="team-members" title={t('team.members.title')} help={t('team.members.help')}>
        {data && !data.canManage && <ReadOnlyNote />}
        <Loading
          what={t('team.members.what')}
          loading={!data}
          error={error}
          onRetry={() => void load()}
          skeleton={<SkeletonList rows={2} lead={24} aside />}
        >
          {data && (
            <List label={t('team.members.title')}>
              {membersInOrder(data.members).map(m => (
                <MemberRow key={m.memberId} data={data} m={m} run={run} onEdit={() => setEditing(m)} />
              ))}
            </List>
          )}
        </Loading>
        {/* Invite: one row at the bottom of the members, under a line (LIN-766). */}
        {data?.canManage && <InviteForm data={data} run={run} toast={toast} />}
        {editing && (
          <MemberEditDialog
            memberId={editing.memberId}
            name={editing.name || editing.email}
            onClose={() => setEditing(null)}
            toast={toast}
          />
        )}
      </Section>
      {/* Only while someone is invited: nothing pending needs no card. */}
      {data && data.invitations.length > 0 && (
        <Section id="team-invites" title={t('team.invitations.title')} description={t('team.invitations.description')}>
          <List label={t('team.invitations.title')}>
            {data.invitations.map(i => (
              <InvitationRow key={i.invitationId} invite={i} canManage={data.canManage} run={run} />
            ))}
          </List>
        </Section>
      )}
      <NotificationDefaults toast={toast} />
    </>
  )
}
