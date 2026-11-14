// The one path for actions. Validate, authorize, run in a transaction, record the command.
// Idempotent per command id: a replayed command returns its first result.
// Read-only actions skip the command log: nothing to replay, nothing to audit.
import { secondFactorRefusal } from './admin-second-factor.ts'
import { passkeyStepUpRefusal } from './admin-step-up.ts'
import { OWNER_STEP_UP_ACTIONS, ownerStepUpNeeded, ownerStepUpRefusal } from './owner-step-up.ts'
import { actions, droppedFields, setsTransferNumber, inputErrorText, redactInput, unknownFieldsText, type ActionDef, type ActionRejection, type ActionResult } from '@linedesk/actions'
import { commands } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { replayedResult, storedInput, storedResult } from './command-log.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, preparers, Reject, runHandler, type Undo } from './handlers.ts'
import { mayRunWhileImpersonating, NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'

export type RunResult = { status: 200 | 403 | 404 | 409 | 422; body: ActionResult | ActionRejection }

/** API keys run only the actions of the public API (`public` in the registry, GET /v1/openapi.json). */
export const API_KEY_PUBLIC_ONLY = 'API keys can only run the actions of the public API (GET /v1/openapi.json); do this in the app'

const rejection = (status: RunResult['status'], error: string): RunResult => ({ status, body: { ok: false, error } })
const forbidden = (error: string): RunResult => ({ status: 403, body: { ok: false, error, code: 'forbidden' } })

/** A handler's rejection: 403 when the caller may not do it, 409 when the data's state does not allow it. */
const statusOf = (body: ActionRejection): RunResult['status'] => (body.code === 'forbidden' ? 403 : 409)
const rejectionBody = (e: Reject, notes: string[] = []): ActionRejection => ({
  ok: false,
  error: [e.message, ...notes].join('; '),
  ...(e instanceof Forbidden ? { code: 'forbidden' as const } : {}),
})

/**
 * Input fields an action does not take. Our own clients (the browser, also when its outbox replays
 * a command stored by an older release after a deploy, and the voice agent, which can run one
 * release behind the API) get them dropped with a warning in the log, so a change made before an
 * update is not lost. Everyone else (API keys, scripts) gets 422: a misspelt field must not pass silently.
 */
function unknownFieldsRefusal(name: string, rawInput: unknown, parsed: unknown, actor: Actor): RunResult | null {
  const dropped = droppedFields(rawInput, parsed)
  if (!dropped.length) return null
  if (actor.sessionId || actor.role === 'agent') {
    console.warn(`${name}: ignored input fields it does not take: ${dropped.join(', ')}`)
    return null
  }
  return rejection(422, unknownFieldsText(dropped))
}

/**
 * What can let someone in later, carry data out or cost money waits until the member's address is
 * confirmed: whoever signs up with someone else's address and a password must not set any of it up
 * before the owner confirms the address (docs/architecture.md, account linking).
 */
export const NEEDS_CONFIRMED_EMAIL: ReadonlySet<string> = new Set([
  'apiKey.create',
  'webhook.create',
  'webhook.update',
  'team.invite',
  'team.resendInvite',
  'carrier.set',
  'phoneNumber.setup',
  // Where calls go: forwarding a number, bookings with callers' details into a calendar.
  'phoneNumber.update',
  // A real call to the business's phone, at the install's cost.
  'phoneNumber.checkForwarding',
  // A carrier lookup, at the cost of the workspace's or the install's carrier account.
  'phoneNumber.lookupLine',
  'calendar.connectStart',
  'calendar.connectFinish',
  'calendar.connectWithPassword',
  // Deletes the workspace and the accounts of members who have no other one.
  'workspace.deleteOwn',
])

/**
 * Whether running `name` with this input waits for a confirmed email. An assistant change that puts calls
 * through to a number (a transfer contact switched on with a number) does; switching contacts off is fine.
 */
export const needsConfirmedEmail = (name: string, input: unknown) =>
  NEEDS_CONFIRMED_EMAIL.has(name) || (name === 'assistant.update' && setsTransferNumber(input))
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED'
const emailNotVerified: RunResult = { status: 403, body: { ok: false, error: 'Confirm your email first', code: EMAIL_NOT_VERIFIED } as ActionRejection }

/** Runs every undo, newest first; each reports in a few words what it did, or that it failed. */
async function runUndos(undos: Undo[]): Promise<string[]> {
  const notes: string[] = []
  for (const undo of undos.reverse()) notes.push(await undo().catch(e => `undo failed: ${e instanceof Error ? e.message : e}`))
  return notes
}

/**
 * Actions that open a call or find one by number: the install-wide agent token, never a call token.
 * Compat window: until the contract step, the install-wide token (with x-workspace-id) still runs every
 * agent action in any workspace, for agents older than the call token. Remove that by 2026-12-31: then
 * the install-wide token runs only these actions and GET /v1/agent/provider-config.
 */
const INSTALL_AGENT_ACTIONS = ['call.start', 'call.startTest', 'call.findForTest', 'call.listNumbers']

/**
 * Why the voice agent may not run this action with this input, or null. Its role has only `agent`;
 * a member action needs `def.agent`, and `agent: 'call'` needs the call it is for. A call token
 * (`actor.callId`) runs only actions for its own call.
 */
export function agentRefusal(def: ActionDef, input: unknown, actor: Actor): string | null {
  if (actor.role !== 'agent') return null
  if (def.permission !== 'agent' && !def.agent) return `the voice agent may not run ${def.name}`
  const callId = (input as { callId?: unknown }).callId
  if (def.agent === 'call' && typeof callId !== 'string') return `the voice agent runs ${def.name} only with its callId`
  if (!actor.callId) return null
  if (INSTALL_AGENT_ACTIONS.includes(def.name)) return `${def.name} needs the agent token, not a call token`
  if (callId !== undefined && callId !== actor.callId) return 'this call token is for another call'
  return null
}

async function runReadOnly(def: ActionDef, input: unknown, actor: Actor): Promise<RunResult> {
  try {
    return { status: 200, body: { ok: true, ...(await runHandler({ tx: db, actor, now: new Date().toISOString() }, def, input)) } }
  } catch (e) {
    if (!(e instanceof Reject)) throw e
    const body = rejectionBody(e)
    return { status: statusOf(body), body }
  }
}

export async function runAction(name: string, rawInput: unknown, actor: Actor, commandId: string = crypto.randomUUID()): Promise<RunResult> {
  const def = actions.get(name)
  if (!def) return rejection(404, `unknown action ${name}`)
  const refusal = secondFactorRefusal(actor, def.permission)
  if (refusal) return { status: 403, body: refusal }
  const allowed = actor.role === 'agent' && def.agent ? actor.permissions.includes('agent') : actor.permissions.includes(def.permission)
  if (!allowed) return forbidden(`missing permission ${def.permission}`)
  // An instance admin signed in as this user: reads and a short allow-list only (impersonation-guard.ts).
  if (actor.impersonation && !mayRunWhileImpersonating(def)) return forbidden(NOT_WHILE_IMPERSONATING)
  // A leaked key must not reach settings: carrier, numbers, transfer number, webhooks, calendars.
  if (actor.apiKeyId && !def.public) return forbidden(API_KEY_PUBLIC_ONLY)
  if (actor.emailUnverified && needsConfirmedEmail(name, rawInput)) return emailNotVerified
  const parsed = def.input.safeParse(rawInput)
  if (!parsed.success) return rejection(422, inputErrorText(parsed.error, rawInput))
  const agentRefused = agentRefusal(def, parsed.data, actor)
  if (agentRefused) return forbidden(agentRefused)
  const unknown = unknownFieldsRefusal(name, rawInput, parsed.data, actor)
  if (unknown) return unknown
  const stepUp = await passkeyStepUpRefusal(def, parsed.data, actor)
  if (stepUp) return { status: 403, body: stepUp }
  // An owner deleting their workspace signs in again first (owner-step-up.ts); the handler checks it once more.
  const ownerStepUp = OWNER_STEP_UP_ACTIONS.has(name) ? await ownerStepUpNeeded(db, actor) : null
  if (ownerStepUp) return { status: 403, body: ownerStepUpRefusal(ownerStepUp) }
  if (def.readOnly) return runReadOnly(def, parsed.data, actor)

  const [seen] = await db.select().from(commands).where(eq(commands.id, commandId))
  if (seen) {
    // A command id belongs to the workspace and action that used it first; nobody else gets its result.
    if (seen.workspace_id !== actor.workspaceId || seen.action !== name) return rejection(409, 'idempotency key was used for another command')
    // Rows are read again by id (command-log.ts).
    const body = (await replayedResult(db, seen.workspace_id, seen.result)) as RunResult['body']
    return { status: body.ok ? 200 : statusOf(body), body }
  }

  // The command log never holds a secret: sensitive input fields are stored redacted.
  // While an instance admin is signed in as a user, the command is the user's, done by that admin.
  const record = {
    id: commandId,
    workspace_id: actor.workspaceId,
    actor_id: actor.actorId,
    impersonated_by: actor.impersonation?.by ?? null,
    // An AI agent with the admin's setup key (agent-setup.ts): the audit log says so.
    setup_key_id: actor.setupKeyId ?? null,
    action: name,
    input: storedInput(def, redactInput(def, parsed.data)) as object,
  }
  // What handlers did outside the database (a bought phone number) is undone whenever the
  // transaction does not commit: the handler threw, the command could not be logged, or the commit failed.
  const undos: Undo[] = []
  const onRollback = (undo: Undo) => void undos.push(undo)
  try {
    const prepare = preparers[name]
    const prepared = prepare ? await prepare({ actor, now: new Date().toISOString(), onRollback }, parsed.data) : undefined
    const body = await db.transaction(async tx => {
      const ctx = { tx, actor, now: new Date().toISOString(), onRollback, prepared }
      const result: ActionResult = { ok: true, ...(await runHandler(ctx, def, parsed.data)) }
      // A secret in the result (a new API key) goes to the caller once and never into the log, so a replay does not repeat it.
      // Rows only by id (a replay reads them again), and no secret or personal data (command-log.ts).
      await tx.insert(commands).values({ ...record, result: storedResult(def, result) })
      return result
    })
    return { status: 200, body }
  } catch (e) {
    const undone = await runUndos(undos)
    if (!(e instanceof Reject)) {
      if (undone.length) console.error(`${name} failed after it had side effects: ${undone.join('; ')}`)
      throw e // unexpected: 500, the client retries
    }
    const body = rejectionBody(e, undone)
    await db.insert(commands).values({ ...record, result: body, rejected: true }).onConflictDoNothing()
    return { status: statusOf(body), body }
  }
}
