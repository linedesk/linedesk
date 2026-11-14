// Workspace settings › Team › Edit: an owner or admin changes a teammate's profile (name, picture) and their
// notifications in this workspace, with the same fields as the member's own pages (AvatarField, NotificationSwitches).
// Never their email, password, passkeys, sign-in methods, sessions or API keys: those stay with the person. Each
// change is saved at once (the name with Save) through the team.* actions; the member's own pages say who changed
// them last. The API checks who may edit whom (apps/api/src/team-member-edit.ts).
import type { MemberEditData } from '@linedesk/actions'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Field, Section, TextInput } from '../settings/fields.tsx'
import { type NotificationChange, NotificationSwitches, withChange } from '../settings/Notifications.tsx'
import { AvatarField } from '../settings/account/AvatarField.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { Dialog } from '../ui/form.tsx'
import { Avatar, Button } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { refreshTeam, teamApi } from './team-api.ts'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function useMemberEdit(memberId: string) {
  const [data, setData] = useState<MemberEditData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await teamApi.getMember(memberId))
    } catch (e) {
      setError(message(e))
    }
  }, [memberId])
  useEffect(() => void load(), [load])
  return { data, setData, error, reload: load }
}

export function MemberEditDialog({
  memberId,
  name,
  onClose,
  toast,
}: {
  memberId: string
  /** The name the team list shows, for the title while the member loads. */
  name: string
  onClose: () => void
  toast: (text: string) => void
}) {
  const { data, setData, error, reload } = useMemberEdit(memberId)
  const shownName = data?.member.name || name
  return (
    <Dialog
      title={`Edit ${shownName}`}
      description={`Changes are visible to ${shownName}.`}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose} title="Close (Esc)">
          Done
        </Button>
      }
    >
      <Loading
        what={`${shownName}'s settings`}
        loading={!data}
        error={error}
        onRetry={() => void reload()}
        skeleton={<SkeletonFields fields={3} />}
      >
        {data && <MemberEditForm data={data} setData={setData} toast={toast} />}
      </Loading>
    </Dialog>
  )
}

function MemberEditForm({
  data,
  setData,
  toast,
}: {
  data: MemberEditData
  setData: (next: MemberEditData) => void
  toast: (text: string) => void
}) {
  const run = useWriteAction()
  const { member } = data
  const [name, setName] = useState(member.name)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const trimmed = name.trim()
  const dirty = trimmed !== member.name

  async function saveName(e: FormEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!trimmed || !dirty || saving) return
    setSaving(true)
    setProblem(null)
    try {
      // The member's synced row comes back with the result: assignee chips show the new name at once.
      await run('team.updateMemberProfile', { memberId: member.memberId, name: trimmed })
      setData({ ...data, member: { ...member, name: trimmed } })
      void refreshTeam()
      toast('Name saved.')
    } catch (err) {
      setProblem(message(err))
    } finally {
      setSaving(false)
    }
  }

  async function changeNotifications(change: NotificationChange) {
    const before = data
    setData({ ...data, notifications: withChange(data.notifications, change) })
    try {
      await teamApi.setMemberNotifications(member.memberId, change)
    } catch (err) {
      setData(before)
      toast(message(err))
    }
  }

  const nameHelp = data.inOtherWorkspaces
    ? 'This changes their name in every workspace they are in.'
    : 'Their name belongs to their account: it also shows in any workspace they join later.'

  return (
    <>
      <Section id="team-edit-profile" title="Profile">
        {data.profileEditable ? (
          <>
            <AvatarField
              name={member.name || member.email}
              avatarUrl={member.avatarUrl ?? null}
              member={{
                memberId: member.memberId,
                onSaved: avatarUrl => {
                  setData({ ...data, member: { ...member, avatarUrl } })
                  void refreshTeam()
                },
              }}
            />
            <form className="team-edit-name" onSubmit={e => void saveName(e)}>
              <Field id="team-edit-name" label="Name" tip={nameHelp} error={trimmed ? problem : 'Enter a name.'}>
                <TextInput id="team-edit-name" value={name} onChange={setName} invalid={!trimmed} />
              </Field>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                busy={saving}
                disabled={!dirty || !trimmed || saving}
                title="Save the name (⏎)"
              >
                Save
              </Button>
            </form>
          </>
        ) : (
          <>
            <Field label="Picture">
              <Avatar name={member.name || member.email} src={member.avatarUrl ?? null} size={56} />
            </Field>
            <Field label="Name">
              <span className="ac-value">{member.name}</span>
            </Field>
            <p className="help">Also in another workspace, so only they can change their name and picture.</p>
          </>
        )}
        <Field label="Email" tip="Email, password, passkeys and sessions stay with them.">
          <span className="ac-value">{member.email}</span>
        </Field>
      </Section>
      <Section id="team-edit-notify" title="Notifications" description="In this workspace.">
        <NotificationSwitches
          them
          settings={data.notifications}
          canAssign={data.canAssign}
          pushOn={data.notifications.push.devices.length > 0}
          pushSummaryOffOnly
          onChange={change => void changeNotifications(change)}
        />
        <p className="help">Notifications on their devices are turned on and off on each device.</p>
      </Section>
    </>
  )
}
