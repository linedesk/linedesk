// Workspace settings › Team › Edit: an owner or admin changes a teammate's profile (name, picture) and their
// notifications in this workspace, with the same fields as the member's own pages (AvatarField, NotificationSwitches).
// Never their email, password, passkeys, sign-in methods, sessions or API keys: those stay with the person. Each
// change is saved at once (the name with Save) through the team.* actions; the member's own pages say who changed
// them last. The API checks who may edit whom (apps/api/src/team-member-edit.ts).
import type { MemberEditData } from '@linedesk/actions'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Field, Section, TextInput } from '../settings/fields.tsx'
import { type NotificationChange, NotificationSwitches, WhoHearsLine, withChange } from '../settings/Notifications.tsx'
import { AvatarField } from '../settings/account/AvatarField.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { Dialog } from '../ui/form.tsx'
import { Avatar, Button } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { refreshTeam, teamApi } from './team-api.ts'
import { useT } from '@linedesk/i18n/react'

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
  const t = useT()
  const { data, setData, error, reload } = useMemberEdit(memberId)
  const shownName = data?.member.name || name
  return (
    <Dialog
      title={t('team.edit.title', { name: shownName })}
      description={t('team.edit.description', { name: shownName })}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose} title={t('common.action.closeWithKey', { key: 'Esc' })}>
          {t('team.edit.done')}
        </Button>
      }
    >
      <Loading
        what={t('team.edit.what', { name: shownName })}
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
  const t = useT()
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
      toast(t('account.profile.nameSaved'))
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

  const nameHelp = data.inOtherWorkspaces ? t('team.edit.nameEverywhere') : t('team.edit.nameAccount')

  return (
    <>
      <Section id="team-edit-profile" title={t('account.nav.profile.label')}>
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
              <Field
                id="team-edit-name"
                label={t('account.profile.name')}
                tip={nameHelp}
                error={trimmed ? problem : t('team.edit.enterName')}
              >
                <TextInput id="team-edit-name" value={name} onChange={setName} invalid={!trimmed} />
              </Field>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                busy={saving}
                disabled={!dirty || !trimmed || saving}
                title={t('common.withKey', { label: t('team.edit.saveName'), key: '⏎' })}
              >
                {t('common.action.save')}
              </Button>
            </form>
          </>
        ) : (
          <>
            <Field label={t('account.picture.label')}>
              <Avatar name={member.name || member.email} src={member.avatarUrl ?? null} size={56} />
            </Field>
            <Field label={t('account.profile.name')}>
              <span className="ac-value">{member.name}</span>
            </Field>
            <p className="help">{t('team.edit.otherWorkspace')}</p>
          </>
        )}
        <Field label={t('account.profile.email')} tip={t('team.edit.emailTip')}>
          <span className="ac-value">{member.email}</span>
        </Field>
      </Section>
      <Section
        id="team-edit-notify"
        title={t('account.nav.notifications.label')}
        description={t('team.edit.inThisWorkspace')}
      >
        <NotificationSwitches
          them
          settings={data.notifications}
          canAssign={data.canAssign}
          pushOn={data.notifications.push.devices.length > 0}
          pushSummaryOffOnly
          onChange={change => void changeNotifications(change)}
        />
        <p className="help">{t('team.edit.devices')}</p>
        <p className="help">
          <WhoHearsLine />
        </p>
      </Section>
    </>
  )
}
