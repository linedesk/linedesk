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

const showAvatar = (avatarUrl: string | null) =>
  setQueryData<Account | undefined>(ACCOUNT, a => (a ? { ...a, avatarUrl } : a), { persist: true })

export function AvatarField({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const run = useWriteAction()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [cropping, setCropping] = useState<File | null>(null)

  async function save(
    action: 'account.setAvatar' | 'account.removeAvatar',
    input: object,
    shown: string | null,
    text: string,
  ) {
    const before = avatarUrl
    showAvatar(shown)
    try {
      showAvatar((await run<UserAvatarData>(action, input)).avatarUrl)
      setDone(text)
      void refreshTeam() // the team list shows the new picture
    } catch (e) {
      showAvatar(before)
      setProblem(e instanceof Error ? e.message : 'Could not save the picture. Try again.')
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
    await save('account.setAvatar', { avatar }, avatar, 'Picture saved.')
  }

  function remove() {
    if (busy) return
    setProblem(null)
    setDone(null)
    setBusy('remove')
    void save('account.removeAvatar', {}, null, 'Picture removed.')
  }

  return (
    <Field
      id="ac-avatar"
      label="Picture"
      tip="Shown to your team wherever you appear, for example on calls assigned to you. A square image works best."
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
            title="Crop your picture"
            size={LOGO_SIZE}
            maxBytes={LOGO_MAX_BYTES}
            what="The picture"
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
          title="Choose an image of you"
        >
          {avatarUrl ? 'Replace…' : 'Upload…'}
        </Button>
        {avatarUrl && (
          <Button
            size="sm"
            variant="ghost"
            busy={busy === 'remove'}
            disabled={!!busy}
            onClick={remove}
            title="Show your initials instead"
          >
            Remove
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
