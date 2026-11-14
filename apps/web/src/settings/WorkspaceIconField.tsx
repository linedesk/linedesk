// Workspace settings › General › Workspace icon: a logo or image for the workspace button, the workspace menu and
// switcher, and the browser tab while the workspace is open (workspace.setIcon / workspace.removeIcon). The image is
// made a PNG in the browser (ui/imageAsPng.ts), sent directly, not through the outbox (up to half a megabyte), and
// shown everywhere at once (changedWorkspaceIcon): the picked image while it saves, the server's address after.
import { LOGO_MAX_BYTES, LOGO_SIZE, type WorkspaceIconData } from '@linedesk/actions'
import { useRef, useState } from 'react'
import { changedWorkspaceIcon } from '../session.ts'
import { useWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { WorkspaceMark, workspaceIconOf } from '../shell/WorkspaceMark.tsx'
import { tabWorkspace } from '../tabWorkspace.ts'
import { IMAGE_ACCEPT, imageAsPng } from '../ui/imageAsPng.ts'
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

  async function pick(file: File | undefined) {
    if (!file || busy) return
    setProblem(null)
    setBusy('upload')
    let icon: string
    try {
      icon = await imageAsPng(file, { size: LOGO_SIZE, maxBytes: LOGO_MAX_BYTES, what: 'The icon' })
    } catch (e) {
      setBusy(null)
      setProblem(e instanceof Error ? e.message : 'Could not read that image.')
      return
    }
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
      help={
        canEdit
          ? `On the workspace button, in the workspace menu and as the browser tab icon. A square PNG, JPEG, WebP or SVG works best; it is saved as a PNG of at most ${LOGO_SIZE}×${LOGO_SIZE} pixels.`
          : readOnlyNote
      }
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
                void pick(e.target.files?.[0])
                e.target.value = ''
              }}
            />
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
