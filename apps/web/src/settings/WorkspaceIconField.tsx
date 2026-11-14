// Workspace settings › General › Workspace icon: a logo or image for the workspace button, the workspace menu and
// switcher, and the browser tab while the workspace is open (workspace.setIcon / workspace.removeIcon). The picked
// image opens in the crop step (ui/ImageCrop.tsx, rounded-square preview); the kept square is made a PNG in the
// browser, sent directly, not through the outbox (up to half a megabyte), and shown everywhere at once
// (changedWorkspaceIcon): the cropped image while it saves, the server's address after. Only the square is stored.
import { LOGO_MAX_BYTES, LOGO_SIZE, type WorkspaceIconData } from '@linedesk/actions'
import { useRef, useState } from 'react'
import { changedWorkspaceIcon } from '../session.ts'
import { useWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { WorkspaceMark, workspaceIconOf } from '../shell/WorkspaceMark.tsx'
import { tabWorkspace } from '../tabWorkspace.ts'
import { ImageCrop } from '../ui/ImageCrop.tsx'
import { IMAGE_ACCEPT } from '../ui/imageAsPng.ts'
import { Button } from '../ui/kit.tsx'
import { Field } from './fields.tsx'
import { callAction } from './settings-api.ts'

type Props = {
  canEdit: boolean
  name: string
  readOnlyNote: string
  toast: (text: string) => void
}

export function WorkspaceIconField({ canEdit, name, readOnlyNote, toast }: Props) {
  const id = tabWorkspace() ?? ''
  const iconUrl = workspaceIconOf(useWorkspaces(), id)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [cropping, setCropping] = useState<File | null>(null)

  async function save(change: () => Promise<WorkspaceIconData>, shown: string | null, done: string) {
    const before = iconUrl
    changedWorkspaceIcon(id, shown)
    try {
      changedWorkspaceIcon(id, (await change()).iconUrl)
      toast(done)
    } catch (e) {
      changedWorkspaceIcon(id, before)
      setProblem(e instanceof Error ? e.message : 'Could not save the icon. Try again.')
    } finally {
      setBusy(null)
    }
  }

  function pick(file: File | undefined) {
    if (!file || busy) return
    setProblem(null)
    setCropping(file)
  }

  // The crop step's Save: the dialog closes and the icon shows at once while it saves.
  async function saveCropped(icon: string) {
    setCropping(null)
    setBusy('upload')
    await save(() => callAction<WorkspaceIconData>('workspace.setIcon', { icon }), icon, 'Workspace icon saved.')
  }

  function remove() {
    if (busy) return
    setProblem(null)
    setBusy('remove')
    void save(() => callAction<WorkspaceIconData>('workspace.removeIcon'), null, 'Workspace icon removed.')
  }

  return (
    <Field
      id="ws-icon"
      label="Workspace icon"
      help={canEdit ? 'A square image works best.' : readOnlyNote}
      tip="Shown on the workspace button, in the workspace menu and as the browser tab icon."
      error={problem}
    >
      <div className="st-ws-icon">
        <WorkspaceMark name={name} iconUrl={iconUrl} size="lg" />
        {canEdit && (
          <>
            <input
              ref={fileRef}
              id="ws-icon"
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
                shape="rounded-square"
                title="Crop the workspace icon"
                size={LOGO_SIZE}
                maxBytes={LOGO_MAX_BYTES}
                what="The icon"
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
              title="Choose an image for the workspace icon"
            >
              {iconUrl ? 'Replace…' : 'Upload…'}
            </Button>
            {iconUrl && (
              <Button
                size="sm"
                variant="ghost"
                busy={busy === 'remove'}
                disabled={!!busy}
                onClick={remove}
                title="Show the initial of the name instead"
              >
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </Field>
  )
}
