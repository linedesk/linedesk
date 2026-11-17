// The one confirmation for heavy, destructive steps (deleting a workspace in Server admin or in Workspace settings,
// disabling, granting admin): what it affects in a danger note, an optional checkbox, the name typed to unlock
// the button, and why it failed in one short sentence. The caller's `run` does the work; on success the dialog stays
// busy until the caller closes it or the page moves on.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { stepUpRefusalText } from '../admin/PasskeyStepUp.tsx'
import { errorText } from '../admin/notify.ts'
import { rejectionReason } from '../shell/rejections.ts'
import { Checkbox } from './controls.tsx'
import { Dialog, FormField, Input } from './form.tsx'
import { Button, Note } from './kit.tsx'
import { useT } from '@linedesk/i18n/react'

export type DangerConfirmation = {
  text: string
  /** What it affects, one item a line (a delete lists what goes), in a danger note titled `after`. */
  list?: string[]
  after?: string
  /** The confirming button. */
  action: string
  /** The button that closes without doing it; "Cancel" when not given (a cancel flow says "Keep my plan"). */
  dismiss?: string
  /** The button's words while it runs ("Deleting…"). */
  busyAction?: string
  /** The heaviest actions: the button unlocks once this is typed. */
  typed?: string
  variant?: 'primary' | 'danger' | 'danger-outline'
  /** A checkbox under the list, off by default; `run` gets whether it is ticked. */
  option?: string
  /** A second way to confirm, next to the main button (resolves like `run`). */
  alternative?: { action: string; tip: string; run: () => Promise<unknown> }
  /**
   * A short text the action needs (why an admin signs in as a user): the button unlocks once it has `min` characters;
   * `run` gets it, trimmed.
   */
  reason?: { label: string; placeholder: string; min: number; max: number }
}

/** Why a confirmed action did not go through, in one short sentence for the dialog's error note. */
export function confirmErrorText(err: unknown): string {
  const refused = stepUpRefusalText(err)
  if (refused) return refused
  const text = errorText(err)
  // A proxy's error page instead of the API's answer (an update, a restart): no reason worth showing.
  return rejectionReason(/^The server answered \d{3}$/.test(text) ? '' : text)
}

/**
 * What the dialog's error note says when `run` failed: nothing when the caller explains that refusal itself (a note
 * in `children`, like "Sign in again first"), so it is not said twice.
 */
export const confirmFailureText = (err: unknown, explains?: (err: unknown) => boolean): string | null =>
  explains?.(err) ? null : confirmErrorText(err)

/** Whether the typed text unlocks the button: the same name, case and outer spaces aside (as the API checks it). */
export const typedMatches = (typed: string, expected: string | undefined) =>
  !expected || typed.trim().toLowerCase() === expected.trim().toLowerCase()

type Props = {
  confirm: DangerConfirmation
  /** Does the work; throws to show why it failed. `option`: whether the checkbox is ticked; `reason`: the text asked for. */
  run: (option: boolean, reason: string) => Promise<void>
  onClose: () => void
  /** Shown after the list, before the checkbox (a separate warning); gets whether the checkbox is ticked. */
  children?: ReactNode | ((option: boolean) => ReactNode)
  /** Keeps the confirming button locked (something must happen first, said in `children`). */
  blocked?: boolean
  /** Refusals the caller explains in `children` (the dialog then adds no error note of its own). */
  explains?: (err: unknown) => boolean
}

export function DangerConfirmDialog({ confirm, run, onClose, children, blocked = false, explains }: Props) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const [option, setOption] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The confirming button had the focus and was disabled while `run` ran, so the focus fell out of the dialog: after
  // a failure it goes back in (that button, or Cancel while it stays locked), so Esc and Tab work again.
  const [failures, setFailures] = useState(0)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (failures === 0) return
    const confirmTarget = confirmButton.current
    ;(confirmTarget && !confirmTarget.disabled ? confirmTarget : cancelButton.current)?.focus()
  }, [failures])
  const reasonGiven = !confirm.reason || reason.trim().length >= confirm.reason.min
  const unlocked = !blocked && typedMatches(typed, confirm.typed) && reasonGiven
  async function submit(e: FormEvent, work: (option: boolean, reason: string) => Promise<unknown> = run) {
    e.preventDefault()
    if (!unlocked || busy) return
    setBusy(true)
    setError(null)
    try {
      await work(option, reason.trim())
    } catch (err) {
      // Busy ends with any failure: the dialog is usable again (Cancel, Esc, the box, another try).
      setError(confirmFailureText(err, explains))
      setBusy(false)
      setFailures(n => n + 1)
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
          <Button ref={cancelButton} variant="ghost" onClick={onClose} disabled={busy}>
            {confirm.dismiss ?? t('common.action.cancel')}
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
          <Button
            ref={confirmButton}
            busy={busy}
            type="submit"
            variant={confirm.variant ?? 'danger'}
            disabled={!unlocked || busy}
          >
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
      {confirm.reason && (
        <FormField id="danger-confirm-reason" label={confirm.reason.label}>
          <Input
            id="danger-confirm-reason"
            value={reason}
            placeholder={confirm.reason.placeholder}
            maxLength={confirm.reason.max}
            autoComplete="off"
            disabled={busy}
            onChange={e => setReason(e.target.value)}
          />
        </FormField>
      )}
      {confirm.typed && (
        <Input
          value={typed}
          placeholder={confirm.typed}
          aria-label={t('common.dangerConfirm.typeToConfirm', { text: confirm.typed })}
          autoComplete="off"
          disabled={busy}
          onChange={e => setTyped(e.target.value)}
        />
      )}
      {error && <Note tone="danger">{error}</Note>}
    </Dialog>
  )
}
