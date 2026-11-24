// Account settings › Profile › Picture: the member's profile picture, shown wherever they appear (assigned calls, the
// assign picker, the team list, Server admin › Users). Like the workspace icon (WorkspaceIconField.tsx): the picked
// image opens in the crop step (ui/ImageCrop.tsx, round preview), the kept square is made a PNG in the browser and sent
// directly, not through the outbox (up to half a megabyte). Only the cropped square is stored: "Replace…" starts over.
// Shown at once: the picked image here while it saves; the member's own row (workspace_members) comes back with the
// action's result into the store, and the account and the team list are updated in place.
import { LOGO_MAX_BYTES, LOGO_SIZE, type UserAvatarData } from '@linedesk/actions'
import { useRef, useState } from 'react'
import { setQueryData } from '../../cachedQuery.ts'
import { refreshTeam } from '../../team/team-api.ts'
import { ImageCrop } from '../../ui/ImageCrop.tsx'
import { IMAGE_ACCEPT } from '../../ui/imageAsPng.ts'
import { Avatar, Button } from '../../ui/kit.tsx'
import { Field } from '../fields.tsx'
import { useWriteAction } from '../settings-api.ts'
import { ACCOUNT, type Account } from './account-api.ts'
import { useT } from '@linedesk/i18n/react'

/** Your own picture, changed by you: the profile no longer says someone else changed it last. */
const showAvatar = (avatarUrl: string | null) =>
  setQueryData<Account | undefined>(ACCOUNT, a => (a ? { ...a, avatarUrl, profileChangedBy: null } : a), {
    persist: true,
  })

/**
 * `member`: a teammate's picture, changed by an owner or admin (Workspace settings › Team › Edit) with the team.*
 * actions; `onSaved` gets the new address. Without it, the signed-in member's own (Account settings › Profile).
 */
export function AvatarField({
  name,
  avatarUrl,
  member,
}: {
  name: string
  avatarUrl: string | null
  member?: { memberId: string; onSaved: (avatarUrl: string | null) => void }
}) {
  const t = useT()
  const run = useWriteAction()
  const shown = member ? member.onSaved : showAvatar
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [cropping, setCropping] = useState<File | null>(null)

  async function save(remove: boolean, input: object, picked: string | null, text: string) {
    const before = avatarUrl
    const action = member
      ? remove
        ? 'team.removeMemberAvatar'
        : 'team.setMemberAvatar'
      : remove
        ? 'account.removeAvatar'
        : 'account.setAvatar'
    shown(picked)
    try {
      shown((await run<UserAvatarData>(action, member ? { ...input, memberId: member.memberId } : input)).avatarUrl)
      setDone(text)
      void refreshTeam() // the team list shows the new picture
    } catch (e) {
      shown(before)
      setProblem(e instanceof Error ? e.message : t('account.picture.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  function pick(file: File | undefined) {
    if (!file || busy) return
    setProblem(null)
    setDone(null)
    setCropping(file)
  }

  // The crop step's Save: the dialog closes and the picture shows at once while it saves.
  async function saveCropped(avatar: string) {
    setCropping(null)
    setBusy('upload')
    await save(false, { avatar }, avatar, t('account.picture.saved'))
  }

  function remove() {
    if (busy) return
    setProblem(null)
    setDone(null)
    setBusy('remove')
    void save(true, {}, null, t('account.picture.removed'))
  }

  return (
    <Field
      id="ac-avatar"
      label={t('account.picture.label')}
      tip={member ? t('account.picture.tipMember') : t('account.picture.tip')}
      error={problem}
    >
      <div className="ac-avatar">
        <Avatar name={name || '?'} src={avatarUrl} size={56} />
        <input
          ref={fileRef}
          id="ac-avatar"
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          onChange={e => {
            pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {cropping && (
          <ImageCrop
            file={cropping}
            shape="circle"
            title={t('account.picture.crop')}
            size={LOGO_SIZE}
            maxBytes={LOGO_MAX_BYTES}
            what={t('account.picture.what')}
            onCancel={() => setCropping(null)}
            onSave={saveCropped}
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          busy={busy === 'upload'}
          disabled={!!busy}
          onClick={() => fileRef.current?.click()}
          title={member ? t('account.picture.chooseOf', { name }) : t('account.picture.chooseOfYou')}
        >
          {avatarUrl ? t('account.picture.replace') : t('account.picture.upload')}
        </Button>
        {avatarUrl && (
          <Button
            size="sm"
            variant="ghost"
            busy={busy === 'remove'}
            disabled={!!busy}
            onClick={remove}
            title={member ? t('account.picture.initialsMember') : t('account.picture.initials')}
          >
            {t('account.passkeys.remove')}
          </Button>
        )}
        {done && (
          <span className="help" role="status">
            {done}
          </span>
        )}
      </div>
    </Field>
  )
}
