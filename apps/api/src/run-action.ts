// The one write path. Validate, authorize, run in a transaction, record the command.
// Idempotent per command id: a replayed command returns its first result.
import { actions, type ActionRejection, type ActionResult } from '@callfront/actions'
import { commands } from '@callfront/db'
import { eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Reject, runHandler } from './handlers.ts'

export type RunResult = { status: 200 | 403 | 404 | 409 | 422; body: ActionResult | ActionRejection }

const rejection = (status: RunResult['status'], error: string): RunResult => ({ status, body: { ok: false, error } })

export async function runAction(name: string, rawInput: unknown, actor: Actor, commandId: string = crypto.randomUUID()): Promise<RunResult> {
  const def = actions.get(name)
  if (!def) return rejection(404, `unknown action ${name}`)
  if (!actor.permissions.includes(def.permission)) return rejection(403, `missing permission ${def.permission}`)
  const parsed = def.input.safeParse(rawInput)
  if (!parsed.success) return rejection(422, parsed.error.message)

  const [seen] = await db.select().from(commands).where(eq(commands.id, commandId))
  if (seen) return { status: seen.rejected ? 409 : 200, body: seen.result as RunResult['body'] }

  const record = { id: commandId, workspace_id: actor.workspaceId, actor_id: actor.actorId, action: name, input: parsed.data as object }
  try {
    const body = await db.transaction(async tx => {
      const result: ActionResult = { ok: true, ...(await runHandler({ tx, actor, now: new Date().toISOString() }, def, parsed.data)) }
      await tx.insert(commands).values({ ...record, result })
      return result
    })
    return { status: 200, body }
  } catch (e) {
    if (!(e instanceof Reject)) throw e // unexpected: 500, the client retries
    const body: ActionRejection = { ok: false, error: e.message }
    await db.insert(commands).values({ ...record, result: body, rejected: true }).onConflictDoNothing()
    return { status: 409, body }
  }
}
