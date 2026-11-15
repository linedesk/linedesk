// Server admin › Overview: a short note for an instance admin with only one passkey (Janik's decision 2026-11-15:
// recommended, never enforced). A lost device would lock them out of Server admin until the server prints a new
// enrolment code, so a second passkey on another device helps. Dismissed per account in this browser; nothing blocks.
import { useEffect, useState } from 'react'
import { loadPasskeys } from '../settings/account/account-api.ts'
import { Button, Note } from '../ui/kit.tsx'

export const SECOND_PASSKEY_TEXT =
  'Add a second passkey, e.g. on your phone or a security key, so a lost device does not lock you out.'

const key = (account: string) => `linedesk.secondPasskeyNote.${account}`

/** Whether the note shows: exactly one passkey, and not dismissed. */
export const showSecondPasskeyNote = (passkeys: number | null, dismissed: boolean) => passkeys === 1 && !dismissed

export function readDismissed(account: string, store: Pick<Storage, 'getItem'> | null = storage()): boolean {
  try {
    return store?.getItem(key(account)) === '1'
  } catch {
    return false
  }
}

export function rememberDismissed(account: string, store: Pick<Storage, 'setItem'> | null = storage()) {
  try {
    store?.setItem(key(account), '1')
  } catch {
    // Private windows: dismissed for this visit only.
  }
}

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

export function SecondPasskeyNote({ account }: { account: string }) {
  const [count, setCount] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(() => readDismissed(account))
  useEffect(() => {
    if (dismissed) return
    let current = true
    loadPasskeys().then(
      list => current && setCount(list.length),
      () => {}, // the note is a hint: no passkey list, no note
    )
    return () => {
      current = false
    }
  }, [dismissed])
  if (!showSecondPasskeyNote(count, dismissed)) return null
  return (
    <Note
      action={
        <>
          <a className="k-btn k-btn-sm k-btn-secondary" href="#account/security" title="Account › Sign-in & security">
            Add passkey
          </a>
          <Button
            size="sm"
            variant="ghost"
            title="Hide this note"
            onClick={() => {
              rememberDismissed(account)
              setDismissed(true)
            }}
          >
            Dismiss
          </Button>
        </>
      }
    >
      {SECOND_PASSKEY_TEXT}
    </Note>
  )
}
