// The one confirmation for heavy, destructive steps (deleting a workspace in Admin or in Workspace settings,
// disabling, granting admin): what it affects in a danger note, an optional checkbox, the name typed to unlock
// the button, and why it failed in one short sentence. The caller's `run` does the work; on success the dialog stays
// busy until the caller closes it or the page moves on.
import { type FormEvent, type ReactNode, useState } from 'react'
import { stepUpRefusalText } from '../admin/PasskeyStepUp.tsx'
import { errorText } from '../admin/notify.ts'
import { rejectionReason } from '../shell/rejections.ts'
import { Checkbox } from './controls.tsx'
import { Dialog, Input } from './form.tsx'
import { Button, Note } from './kit.tsx'

export type DangerConfirmation = {
  text: string
  /** What it affects, one item a line (a delete lists what goes), in a danger note titled `after`. */
  list?: string[]
  after?: string
  /** The confirming button. */
  action: string
  /** The button's words while it runs ("Deleting…"). */
  busyAction?: string
  /** The heaviest actions: the button unlocks once this is typed. */
  typed?: string
  variant?: 'primary' | 'danger' | 'danger-outline'
  /** A checkbox under the list, off by default; `run` gets whether it is ticked. */
  option?: string
  /** A second way to confirm, next to the main button (resolves like `run`). */
  alternative?: { action: string; tip: string; run: () => Promise<unknown> }
}

/** Why a confirmed action did not go through, in one short sentence for the dialog's error note. */
export function confirmErrorText(err: unknown): string {
  const refused = stepUpRefusalText(err)
  if (refused) return refused
  const text = errorText(err)
  // A proxy's error page instead of the API's answer (an update, a restart): no reason worth showing.
  return rejectionReason(/^The server answered \d{3}$/.test(text) ? '' : text)
}

/** Whether the typed text unlocks the button: the same name, case and outer spaces aside (as the API checks it). */
export const typedMatches = (typed: string, expected: string | undefined) =>
  !expected || typed.trim().toLowerCase() === expected.trim().toLowerCase()

type Props = {
  confirm: DangerConfirmation
  /** Does the work; throws to show why it failed. `option`: whether the checkbox is ticked. */
  run: (option: boolean) => Promise<void>
  onClose: () => void
  /** Shown after the list, before the checkbox (a separate warning); gets whether the checkbox is ticked. */
  children?: ReactNode | ((option: boolean) => ReactNode)
  /** Keeps the confirming button locked (something must happen first, said in `children`). */
  blocked?: boolean
}

export function DangerConfirmDialog({ confirm, run, onClose, children, blocked = false }: Props) {
  const [typed, setTyped] = useState('')
  const [option, setOption] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unlocked = !blocked && typedMatches(typed, confirm.typed)
  async function submit(e: FormEvent, work: (option: boolean) => Promise<unknown> = run) {
    e.preventDefault()
    if (!unlocked || busy) return
    setBusy(true)
    setError(null)
    try {
      await work(option)
    } catch (err) {
      setError(confirmErrorText(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={confirm.action}
      description={confirm.text}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {confirm.alternative && (
            <Button
              variant="danger-outline"
              title={confirm.alternative.tip}
              disabled={!unlocked || busy}
              onClick={e => void submit(e, confirm.alternative!.run)}
            >
              {confirm.alternative.action}
            </Button>
          )}
          <Button busy={busy} type="submit" variant={confirm.variant ?? 'danger'} disabled={!unlocked || busy}>
            {busy && confirm.busyAction ? confirm.busyAction : confirm.action}
          </Button>
        </>
      }
    >
      {(confirm.list || confirm.after) && (
        <Note tone="danger" title={confirm.after}>
          {confirm.list && (
            <ul className="danger-confirm-list">
              {confirm.list.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </Note>
      )}
      {typeof children === 'function' ? children(option) : children}
      {confirm.option && (
        <Checkbox checked={option} onChange={setOption} disabled={busy}>
          {confirm.option}
        </Checkbox>
      )}
      {confirm.typed && (
        <Input
          value={typed}
          placeholder={confirm.typed}
          aria-label={`Type ${confirm.typed} to confirm`}
          autoComplete="off"
          disabled={busy}
          onChange={e => setTyped(e.target.value)}
        />
      )}
      {error && <Note tone="danger">{error}</Note>}
    </Dialog>
  )
}
