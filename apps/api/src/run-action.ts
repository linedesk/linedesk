// The one path for actions. Validate, authorize, run in a transaction, record the command.
// Idempotent per command id: a replayed command returns its first result.
// Read-only actions skip the command log: nothing to replay, nothing to audit.
import { secondFactorRefusal } from './admin-second-factor.ts'
import { actions, inputErrorText, REDACTED, redactInput, type ActionDef, type ActionRejection, type ActionResult } from '@linedesk/actions'
import { commands } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Reject, runHandler, type Undo } from './handlers.ts'

export type RunResult = { status: 200 | 403 | 404 | 409 | 422; body: ActionResult | ActionRejection }

const rejection = (status: RunResult['status'], error: string): RunResult => ({ status, body: { ok: false, error } })

/** Runs every undo, newest first; each reports in a few words what it did, or that it failed. */
async function runUndos(undos: Undo[]): Promise<string[]> {
  const notes: string[] = []
  for (const undo of undos.reverse()) notes.push(await undo().catch(e => `undo failed: ${e instanceof Error ? e.message : e}`))
  return notes
}

async function runReadOnly(def: ActionDef, input: unknown, actor: Actor): Promise<RunResult> {
  try {
    return { status: 200, body: { ok: true, ...(await runHandler({ tx: db, actor, now: new Date().toISOString() }, def, input)) } }
  } catch (e) {
    if (!(e instanceof Reject)) throw e
    return rejection(409, e.message)
  }
}

export async function runAction(name: string, rawInput: unknown, actor: Actor, commandId: string = crypto.randomUUID()): Promise<RunResult> {
  const def = actions.get(name)
  if (!def) return rejection(404, `unknown action ${name}`)
  const refusal = secondFactorRefusal(actor, def.permission)
  if (refusal) return { status: 403, body: refusal }
  if (!actor.permissions.includes(def.permission)) return rejection(403, `missing permission ${def.permission}`)
  const parsed = def.input.safeParse(rawInput)
  if (!parsed.success) return rejection(422, inputErrorText(parsed.error, rawInput))
  if (def.readOnly) return runReadOnly(def, parsed.data, actor)

  const [seen] = await db.select().from(commands).where(eq(commands.id, commandId))
  if (seen) {
    // A command id belongs to the workspace and action that used it first; nobody else gets its result.
    if (seen.workspace_id !== actor.workspaceId || seen.action !== name) return rejection(409, 'idempotency key was used for another command')
    return { status: seen.rejected ? 409 : 200, body: seen.result as RunResult['body'] }
  }

  // The command log never holds a secret: sensitive input fields are stored redacted.
  // While an instance admin is signed in as a user, the command is the user's, done by that admin.
  const record = {
    id: commandId,
    workspace_id: actor.workspaceId,
    actor_id: actor.actorId,
    impersonated_by: actor.impersonation?.by ?? null,
    action: name,
    input: redactInput(def, parsed.data) as object,
  }
  // What handlers did outside the database (a bought phone number) is undone whenever the
  // transaction does not commit: the handler threw, the command could not be logged, or the commit failed.
  const undos: Undo[] = []
  try {
    const body = await db.transaction(async tx => {
      const ctx = { tx, actor, now: new Date().toISOString(), onRollback: (undo: Undo) => undos.push(undo) }
      const result: ActionResult = { ok: true, ...(await runHandler(ctx, def, parsed.data)) }
      // A secret in the result (a new API key) goes to the caller once and never into the log, so a replay does not repeat it.
      await tx.insert(commands).values({ ...record, result: def.secretResult ? { ...result, data: { redacted: REDACTED } } : result })
      return result
    })
    return { status: 200, body }
  } catch (e) {
    const undone = await runUndos(undos)
    if (!(e instanceof Reject)) {
      if (undone.length) console.error(`${name} failed after it had side effects: ${undone.join('; ')}`)
      throw e // unexpected: 500, the client retries
    }
    const body: ActionRejection = { ok: false, error: [e.message, ...undone].join('; ') }
    await db.insert(commands).values({ ...record, result: body, rejected: true }).onConflictDoNothing()
    return { status: 409, body }
  }
}
