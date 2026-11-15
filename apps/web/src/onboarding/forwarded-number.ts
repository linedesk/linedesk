// "Set up forwarding" on the agent setup page (SetupRowActions.tsx) opens the dialog of the workspace's forwarded
// number. The number comes from the local store, which may still be reading it (a new device, or another tab that
// leads the read sync): this waits for it a few seconds, then says what is missing instead of spinning on.
import type { Tables } from '@linedesk/db/types'
import type { Snapshot, Store } from '@linedesk/sync'

/** How long the button waits for the number before it says why there is no dialog. */
export const NUMBER_WAIT_MS = 6000

/** Why there is no dialog: the numbers were read and none forwards, or they did not arrive in time. */
export type NumberMissing = 'none' | 'not_loaded'

export const isForwarded = (n: Pick<Tables['phone_numbers'], 'mode'>) =>
  n.mode === 'forward_conditional' || n.mode === 'forward_all'

export const forwardedNumber = (snapshot: Snapshot) => [...snapshot.tables.phone_numbers.values()].find(isForwarded)

type NumberStore = Pick<Store, 'getSnapshot' | 'subscribe' | 'refresh'>

/**
 * Waits for the workspace's forwarded number: `done` resolves null once it is in the store, 'none' once the numbers
 * were read from the server and none of them forwards, 'not_loaded' when nothing arrived within `ms`. The last two are
 * logged with what the store knows (they reach Sentry): an endless wait had nothing to go on. `cancel` stops waiting.
 * A read that brings no forwarded number is followed by one of the whole table: the device may miss rows its cursor
 * says it has (the setup page names the number because the server has it), and only then is it "none".
 */
export function waitForForwardedNumber(store: NumberStore, ms = NUMBER_WAIT_MS) {
  let over = false
  let settle: (result: NumberMissing | null) => void = () => {}
  const done = new Promise<NumberMissing | null>(resolve => {
    settle = resolve
  })
  /** Whether the store's read of the numbers finished in time: null while it runs. */
  let read: boolean | null = null
  let unsubscribe = () => {}
  const timer = setTimeout(() => {
    if (over) return
    const s = store.getSnapshot()
    console.warn(`Set up forwarding: the workspace's phone numbers did not arrive within ${ms / 1000} s`, {
      readFinished: read,
      numbersOnDevice: s.tables.phone_numbers.size,
      numbersSyncedBefore: s.synced.has('phone_numbers'),
      online: s.online,
      readSyncDown: s.readSyncDown,
      refused: s.refused?.code ?? null,
    })
    finish('not_loaded')
  }, ms)
  function finish(result: NumberMissing | null) {
    if (over) return
    over = true
    clearTimeout(timer)
    unsubscribe()
    settle(result)
  }
  const check = () => {
    if (forwardedNumber(store.getSnapshot())) finish(null)
  }
  unsubscribe = store.subscribe(check)
  check()
  /** Reads the numbers (`fresh`: the whole table); false when the read did not finish in time or a number is here. */
  const readNumbers = async (fresh: boolean) => {
    read = null
    read = await store.refresh(['phone_numbers'], fresh ? { fresh } : undefined)
    return read && !over && !forwardedNumber(store.getSnapshot())
  }
  if (!over)
    void (async () => {
      if (!(await readNumbers(false)) || !(await readNumbers(true))) return check()
      console.warn('Set up forwarding: no forwarded number in this workspace', {
        numbers: [...store.getSnapshot().tables.phone_numbers.values()].map(n => n.mode),
      })
      finish('none')
    })()
  return {
    done,
    cancel: () => {
      over = true
      clearTimeout(timer)
      unsubscribe()
    },
  }
}
