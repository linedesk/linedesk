// A transfer must never ring a phone that sends the call back into Linedesk. assistant.update refuses such a
// number when it is saved (handlers.ts, checkOnCallNotLinedesk); this covers the other direction: a number that
// becomes a Linedesk number, or a business line that starts forwarding to one, after it was saved as a transfer
// contact (a solo owner's mobile is often the business line). Such contacts are switched off, keeping their number.
import { isActiveContact } from '@linedesk/actions'
import { assistants } from '@linedesk/db'
import type { TransferContact } from '@linedesk/db/types'
import { eq } from 'drizzle-orm'
import type { HandlerCtx } from './handler-context.ts'

/**
 * Switches off every active transfer contact of the workspace's assistants whose number is one of `numbers`
 * (E.164). Returns the assistants it changed, for the action's result (the browser shows the change at once).
 * Call it wherever a number starts reaching Linedesk: a number set up, a business line found forwarding.
 */
export async function switchOffLoopingTransfers(tx: HandlerCtx['tx'], workspaceId: string, numbers: string[]) {
  const looping = new Set(numbers)
  const rows = await tx.select().from(assistants).where(eq(assistants.workspace_id, workspaceId))
  const changed = []
  for (const assistant of rows) {
    const list = assistant.transfers as TransferContact[]
    if (!list.some(c => isActiveContact(c) && looping.has(c.number!))) continue
    const transfers = list.map(c => (isActiveContact(c) && looping.has(c.number!) ? { ...c, enabled: false } : c))
    const [row] = await tx.update(assistants).set({ transfers }).where(eq(assistants.id, assistant.id)).returning()
    if (row) changed.push(row)
  }
  return changed
}
