// The one path for actions. Validate, authorize, run in a transaction, record the command.
// Idempotent per command id: a replayed command returns its first result.
// Read-only actions skip the command log: nothing to replay, nothing to audit.
import { adminPasskeyRefusal, secondFactorRefusal } from './admin-second-factor.ts'
import {
  leaveNeedsFreshSignIn,
  leaveSignInRefusal,
  OWNER_STEP_UP_ACTIONS,
  ownerStepUpNeeded,
  ownerStepUpRefusal,
  removeNeedsFreshSignIn,
  removeSignInRefusal,
  setupLinkNeedsFreshSignIn,
  personalKeyStepUpNeeded,
  personalKeyStepUpRefusal,
  setupLinkSignInRefusal,
} from './owner-step-up.ts'
import {
  actions,
  droppedFields,
  rolePermissions,
  setsTransferNumber,
  inputErrorText,
  redactInput,
  UNKNOWN_FIELDS,
  unknownFieldsText,
  type ActionDef,
  type ActionRejection,
  type ActionResult,
} from '@linedesk/actions'
import { createHmac, hkdfSync } from 'node:crypto'
import { commands } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import { replayedResult, storedInput, storedResult } from './command-log.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type Reader, rejectionText, wordsOf } from './handler-context.ts'
import { Forbidden, NotFound, preparers, Reject, runHandler, type Undo } from './handlers.ts'
import { personalKeyRefusal } from './personal-key-scope.ts'
import {
  chargeSetupLookup,
  isPendingPayment,
  PENDING_PAYMENT,
  REFUSED_WHILE_PENDING_PAYMENT,
  SETUP_LOOKUPS,
} from './self-serve.ts'
import { impersonatorOf, mayRunWhileImpersonating, NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { MAIN_HOST_ONLY, mainHostOnlyAction } from './request-host.ts'

export type RunResult = { status: 200 | 403 | 404 | 409 | 422; body: ActionResult | ActionRejection }

/** API keys run only the actions of the public API (`public` in the registry, GET /v1/openapi.json). */
export const API_KEY_PUBLIC_ONLY =
  'API keys can only run the actions of the public API (GET /v1/openapi.json); do this in the app'

const rejection = (status: RunResult['status'], error: string): RunResult => ({ status, body: { ok: false, error } })
const forbidden = (error: string): RunResult => ({ status: 403, body: { ok: false, error, code: 'forbidden' } })

/** A handler's rejection: 403 when the caller may not do it, 404 for what is not theirs, 409 for the data's state. */
const statusOf = (body: ActionRejection): RunResult['status'] =>
  body.code === 'forbidden' ? 403 : body.code === 'not_found' ? 404 : 409
/** `words`: the caller's language (wordsOf); the command log keeps the English. */
const rejectionBody = (e: Reject, notes: string[] = [], words?: Reader): ActionRejection => ({
  ok: false,
  error: [words ? rejectionText(e, words) : e.message, ...notes].join('; '),
  ...(e instanceof Forbidden
    ? { code: 'forbidden' as const }
    : e instanceof NotFound
      ? { code: 'not_found' as const }
      : e.code
        ? { code: e.code }
        : {}),
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
  return unknownFieldsRejection(dropped)
}

/** 422 for fields an action does not take, with its code, from the strict schemas and the check above alike. */
const unknownFieldsRejection = (fields: readonly string[]): RunResult => ({
  status: 422,
  body: { ok: false, error: unknownFieldsText(fields), code: UNKNOWN_FIELDS },
})

/** The unknown fields when they are all that is wrong with the input (a strict schema, DESTRUCTIVE_ACTIONS), else null. */
function onlyUnknownFields(error: z.ZodError): string[] | null {
  const keys = error.issues.flatMap(issue =>
    issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...issue.path, key].join('.')) : [],
  )
  return keys.length && error.issues.every(issue => issue.code === 'unrecognized_keys') ? keys : null
}

/**
 * What can let someone in later, carry data out or cost money waits until the member's address is
 * confirmed: whoever signs up with someone else's address and a password must not set any of it up
 * before the owner confirms the address (docs/architecture.md, account linking).
 */
export const NEEDS_CONFIRMED_EMAIL: ReadonlySet<string> = new Set([
  'apiKey.create',
  // A personal key reaches every workspace of its maker.
  'personalKey.create',
  // So does the key an MCP client gets by OAuth sign-in (oauth.ts).
  'oauth.approve',
  // A workspace owner's AI agent setup link: like an API key, a way in for an agent.
  'agentSetup.createWorkspaceKey',
  'webhook.create',
  'webhook.update',
  // Sends every finished call to an integration (Zapier).
  'integration.subscribe',
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
  // Where every finished call goes, with the caller's details: a connected app such as HubSpot.
  'app.connectStart',
  'app.connectFinish',
  // Every call of a range in one answer.
  'call.export',
  // Call emails to an address outside the team (email routing): the confirmation email goes out to it.
  'emailRecipient.add',
  'emailRecipient.resend',
  'emailRecipient.restore',
  'calendar.connectWithPassword',
  // Deletes the workspace and the accounts of members who have no other one.
  'workspace.deleteOwn',
])

/** What a workspace setup key hears outside its workspace. */
export const WORKSPACE_KEY_SCOPE =
  'This setup link is for one workspace only: it cannot change the server or another workspace.'
/** Whether a workspace setup key's actor reaches past its one workspace (run before every action, as a backstop). */
export function workspaceKeyOutOfScope(def: Pick<ActionDef, 'name' | 'permission'>, actor: Actor): boolean {
  if (def.permission === 'instance:admin') return true
  if (actor.workspaceId === null) return def.name !== 'agentSetup.endOwnAccess'
  if (actor.workspaceId !== actor.setupWorkspaceId) return true
  // Never past the role the key was made with: an admin's key never runs what only the owner may (workspace:own).
  const role = actor.setupWorkspaceRole
  return !role || actor.role !== role || !rolePermissions[role].includes(def.permission)
}

/**
 * Whether running `name` with this input waits for a confirmed email. An assistant change that puts calls
 * through to a number (a transfer contact switched on with a number) does; switching contacts off is fine.
 */
export const needsConfirmedEmail = (name: string, input: unknown) =>
  NEEDS_CONFIRMED_EMAIL.has(name) || (name === 'assistant.update' && setsTransferNumber(input))
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED'
const emailNotVerified: RunResult = {
  status: 403,
  body: { ok: false, error: 'Confirm your email first', code: EMAIL_NOT_VERIFIED } as ActionRejection,
}

/** Runs every undo, newest first; each reports in a few words what it did, or that it failed. */
async function runUndos(undos: Undo[]): Promise<string[]> {
  const notes: string[] = []
  for (const undo of undos.reverse())
    notes.push(await undo().catch(e => `undo failed: ${e instanceof Error ? e.message : e}`))
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

/**
 * Reads that still get a command row when an instance admin is behind them (impersonatorOf: signed in as the user, or
 * an API key made during support access), so `impersonated_by` puts them in the audit log: every call of a range.
 */
export const READS_LOGGED_WHEN_IMPERSONATED: ReadonlySet<string> = new Set(['call.export'])

async function runReadOnly(def: ActionDef, input: unknown, actor: Actor): Promise<RunResult> {
  const result = await runRead(def, input, actor)
  const impersonator = impersonatorOf(actor)
  if (impersonator && READS_LOGGED_WHEN_IMPERSONATED.has(def.name)) {
    // Who, when, which action and the (redacted) input; never the data read. Its own id: a read is not replayed.
    await db.insert(commands).values({
      id: crypto.randomUUID(),
      workspace_id: actor.workspaceId,
      actor_id: actor.actorId,
      impersonated_by: impersonator,
      setup_key_id: actor.setupKeyId ?? null,
      personal_key_id: actor.personalKeyId ?? null,
      action: def.name,
      input: storedInput(def, redactInput(def, input)) as object,
      result: result.body.ok ? { ok: true, rows: {} } : result.body,
    })
  }
  return result
}

async function runRead(def: ActionDef, input: unknown, actor: Actor): Promise<RunResult> {
  try {
    return {
      status: 200,
      body: { ok: true, ...(await runHandler({ tx: db, actor, now: new Date().toISOString() }, def, input)) },
    }
  } catch (e) {
    if (!(e instanceof Reject)) throw e
    const body = rejectionBody(e, [], wordsOf(actor))
    return { status: statusOf(body), body }
  }
}

/**
 * Whether this actor may run the action at all, by the checks that do not depend on the input: what GET /v1/me/actions
 * lists (the CLI) and what MCP offers. runAction checks the same and more.
 */
export function runnableBy(def: ActionDef, actor: Actor): boolean {
  if (actor.partnerHost && mainHostOnlyAction(def, undefined)) return false
  if (secondFactorRefusal(actor, def.permission) || adminPasskeyRefusal(actor, def.permission)) return false
  const allowed =
    actor.role === 'agent' && def.agent
      ? actor.permissions.includes('agent')
      : actor.permissions.includes(def.permission)
  if (!allowed) return false
  if (actor.setupWorkspaceId && workspaceKeyOutOfScope(def, actor)) return false
  if (actor.impersonation && !mayRunWhileImpersonating(def)) return false
  if (actor.apiKeyId && !def.public) return false
  if (actor.personalKeyId && personalKeyRefusal(def.name)) return false
  return true
}

/**
 * A billing action for a white-label partner's bill (`partnerId`, Partner › Billing): someone on a partner team may ask,
 * whatever workspace they are in or none; the handler lets only that partner's owner through (partnerBillOf). The
 * partner's owner holds billing:manage nowhere else but in the client workspaces on their bill (context.ts; security
 * review of #1109, M-1).
 */
function partnerBillCall(def: ActionDef, actor: Actor, rawInput: unknown): boolean {
  if (def.permission !== 'billing:manage' || !actor.permissions.includes('partner')) return false
  const partnerId = (rawInput as { partnerId?: unknown } | null)?.partnerId
  const shape = (def.input as { shape?: Record<string, unknown> }).shape
  return typeof partnerId === 'string' && !!shape && 'partnerId' in shape
}

/**
 * Allow Premium or Allow Ultra asked by a member of the workspace without billing:manage (LIN-440): the bill's owner
 * may switch them where they are only an admin or a member, since the bill pays for them. Only a person signed in as
 * themselves in a workspace; the handler (refuseAllowSwitch) lets through only the bill's owner, or the workspace's
 * owner switching off, and refuses everyone else as before.
 */
const BILL_OWNER_SWITCHES = new Set(['workspace.setAllowPremium', 'workspace.setAllowUltra'])
function billOwnerSwitchCall(def: ActionDef, actor: Actor): boolean {
  // A disabled workspace is read only: refused here with 403, as before, not by the handler.
  if (!BILL_OWNER_SWITCHES.has(def.name) || !actor.workspaceId || actor.workspaceDisabled) return false
  if (actor.role !== 'admin' && actor.role !== 'member') return false
  return !actor.impersonation && !actor.apiKeyId && !actor.personalKeyId && !actor.setupKeyId
}

export async function runAction(
  name: string,
  rawInput: unknown,
  actor: Actor,
  commandId: string = crypto.randomUUID(),
): Promise<RunResult> {
  const def = actions.get(name)
  if (!def) return rejection(404, `unknown action ${name}`)
  // On a white-label partner's address (request-host.ts, S5): what belongs to the install's own address is not there,
  // whoever asks (also before the permission check, so the answer says nothing about the caller's rights).
  if (actor.partnerHost && mainHostOnlyAction(def, rawInput))
    return {
      status: 404,
      body: { ok: false, error: `unknown action ${name}`, code: MAIN_HOST_ONLY } as ActionRejection,
    }
  // Server admin needs the passkey check, for every instance-admin action (admin-second-factor.ts).
  const refusal = secondFactorRefusal(actor, def.permission) ?? adminPasskeyRefusal(actor, def.permission)
  if (refusal) return { status: 403, body: refusal }
  const allowed =
    actor.role === 'agent' && def.agent
      ? actor.permissions.includes('agent')
      : actor.permissions.includes(def.permission) ||
        partnerBillCall(def, actor, rawInput) ||
        billOwnerSwitchCall(def, actor)
  if (!allowed) return forbidden(`missing permission ${def.permission}`)
  // A workspace owner's setup key (agent-setup.ts): its own workspace only, never the server's or another workspace's,
  // whatever the actor says otherwise; outside one, only ending its own link.
  if (actor.setupWorkspaceId && workspaceKeyOutOfScope(def, actor)) return forbidden(WORKSPACE_KEY_SCOPE)
  // An instance admin signed in as this user: reads and a short allow-list only (impersonation-guard.ts).
  if (actor.impersonation && !mayRunWhileImpersonating(def)) return forbidden(NOT_WHILE_IMPERSONATING)
  // A leaked key must not reach settings: carrier, numbers, transfer number, webhooks, calendars.
  if (actor.apiKeyId && !def.public) return forbidden(API_KEY_PUBLIC_ONLY)
  // A personal key is its maker, except for what needs them signed in or a browser (personal-key-scope.ts).
  const personalRefused = actor.personalKeyId ? personalKeyRefusal(name) : null
  if (personalRefused) return forbidden(personalRefused)
  if (actor.emailUnverified && needsConfirmedEmail(name, rawInput)) return emailNotVerified
  // A sign-up waiting for Checkout reaches nothing outside and spends nothing (self-serve.ts; security review F1).
  if (REFUSED_WHILE_PENDING_PAYMENT.has(name) && (await isPendingPayment(db, actor.workspaceId)))
    return rejection(409, PENDING_PAYMENT)
  // Before its trial a workspace runs only `setupLookups` business lookups in all (self-serve.ts).
  if (SETUP_LOOKUPS.has(name)) {
    try {
      await chargeSetupLookup(db, actor)
    } catch (e) {
      if (!(e instanceof Reject)) throw e
      return { status: 409, body: rejectionBody(e, [], wordsOf(actor)) }
    }
  }
  const parsed = def.input.safeParse(rawInput)
  if (!parsed.success) {
    const unknown = onlyUnknownFields(parsed.error)
    return unknown ? unknownFieldsRejection(unknown) : rejection(422, inputErrorText(parsed.error, rawInput))
  }
  const agentRefused = agentRefusal(def, parsed.data, actor)
  if (agentRefused) return forbidden(agentRefused)
  const unknown = unknownFieldsRefusal(name, rawInput, parsed.data, actor)
  if (unknown) return unknown
  // An owner deleting their workspace signs in again first (owner-step-up.ts); the handler checks it once more.
  const ownerStepUp = OWNER_STEP_UP_ACTIONS.has(name) ? await ownerStepUpNeeded(db, actor) : null
  if (ownerStepUp) return { status: 403, body: ownerStepUpRefusal(ownerStepUp) }
  // Leaving one's last workspace and deleting the account needs a sign-in in the last 10 minutes (owner-step-up.ts).
  if (name === 'team.leave' && (await leaveNeedsFreshSignIn(db, actor, parsed.data as { deleteAccount?: unknown })))
    return { status: 403, body: leaveSignInRefusal }
  // So does the owner deleting a removed member's account (owner-step-up.ts; LIN-264 review F3).
  if (
    name === 'team.removeMember' &&
    (await removeNeedsFreshSignIn(db, actor, parsed.data as { deleteAccount?: unknown }))
  )
    return { status: 403, body: removeSignInRefusal }
  // So does a workspace owner's setup link (owner-step-up.ts; security review #822 F2).
  if (name === 'agentSetup.createWorkspaceKey' && (await setupLinkNeedsFreshSignIn(db, actor)))
    return { status: 403, body: setupLinkSignInRefusal }
  // And a personal API key, also one for an MCP client (oauth.approve): a passkey or authenticator confirmation, or a
  // sign-in (owner-step-up.ts; LIN-339 M2).
  // The handler checks it once more.
  const personalKeyStepUp =
    name === 'personalKey.create' || name === 'oauth.approve' ? await personalKeyStepUpNeeded(db, actor) : null
  if (personalKeyStepUp) return { status: 403, body: personalKeyStepUpRefusal(personalKeyStepUp) }
  if (def.readOnly) return runReadOnly(def, parsed.data, actor)

  const inputHash = commandInputHash(def, parsed.data)
  const [seen] = await db.select().from(commands).where(eq(commands.id, commandId))
  if (seen) {
    // A command id belongs to the workspace and action that used it first; nobody else gets its result. One sent in
    // no workspace is its sender's alone, from wherever they send it again: a partner's first client puts them in a
    // workspace, and their retry of it gets that client back, never a second one (security review of #1113, L-3), while
    // nobody else gets it, also not someone in no workspace either (security review of #1115, L-1).
    const owned = seen.workspace_id === null ? seen.actor_id === actor.actorId : seen.workspace_id === actor.workspaceId
    if (!owned || seen.action !== name) return rejection(409, 'idempotency key was used for another command')
    // The same key with other input is a mistake of the caller, not a retry (rows from before the hash: as before).
    if (seen.input_hash && seen.input_hash !== inputHash)
      // i18n-ignore: the API error body for API clients; the web app keeps one key per input (purchaseKeys)
      return rejection(409, 'idempotency key was used with different input')
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
    impersonated_by: impersonatorOf(actor),
    // An AI agent with the admin's setup key (agent-setup.ts): the audit log says so.
    setup_key_id: actor.setupKeyId ?? null,
    // A personal API key (personal-keys.ts): which one, so a leaked key's commands can be told from the person's own.
    personal_key_id: actor.personalKeyId ?? null,
    action: name,
    input: storedInput(def, redactInput(def, parsed.data)) as object,
    input_hash: inputHash,
  }
  // What handlers did outside the database (a bought phone number) is undone whenever the
  // transaction does not commit: the handler threw, the command could not be logged, or the commit failed.
  const undos: Undo[] = []
  const onRollback = (undo: Undo) => void undos.push(undo)
  const committed: (() => Promise<void>)[] = []
  const onCommit = (work: () => Promise<void>) => void committed.push(work)
  try {
    const prepare = preparers[name]
    const prepared = prepare
      ? await prepare({ actor, now: new Date().toISOString(), onRollback, commandId }, parsed.data)
      : undefined
    const body = await db.transaction(async tx => {
      const ctx = { tx, actor, now: new Date().toISOString(), onRollback, onCommit, prepared }
      const result: ActionResult = { ok: true, ...(await runHandler(ctx, def, parsed.data)) }
      // A secret in the result (a new API key) goes to the caller once and never into the log, so a replay does not repeat it.
      // Rows only by id (a replay reads them again), and no secret or personal data (command-log.ts).
      await tx.insert(commands).values({ ...record, result: storedResult(def, result) })
      return result
    })
    for (const work of committed) await work().catch(e => console.error(`${name}: after the commit`, e))
    return { status: 200, body }
  } catch (e) {
    const undone = await runUndos(undos)
    if (!(e instanceof Reject)) {
      if (undone.length) console.error(`${name} failed after it had side effects: ${undone.join('; ')}`)
      throw e // unexpected: 500, the client retries
    }
    const logged = rejectionBody(e, undone)
    await db
      .insert(commands)
      .values({ ...record, result: logged, rejected: true })
      .onConflictDoNothing()
    const body = rejectionBody(e, undone, wordsOf(actor))
    return { status: statusOf(body), body }
  }
}

/** JSON with object keys sorted at every level: the same input gives the same text, whatever order it was sent in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

let hashKey: { secret: string; key: Buffer } | null = null

/**
 * The key of commands.input_hash: derived from BETTER_AUTH_SECRET (HKDF, its own label), kept in memory only, never
 * logged or stored. A table read alone (a backup, a replica) cannot test guesses against a hash (security review of
 * #1116, M-1). Null without the secret: then no hash is kept, and a reused key replays as before.
 */
function inputHashKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) return null
  if (hashKey?.secret !== secret)
    hashKey = { secret, key: Buffer.from(hkdfSync('sha256', secret, '', 'linedesk command input hash v1', 32)) }
  return hashKey.key
}

/**
 * A command's input hash (commands.input_hash): an HMAC of the parsed input with its sensitive fields redacted, as the
 * log keeps them, so no secret (a port-out PIN, a CalDAV password) goes into it in any form; the same key with another
 * secret only replays the first result (security review of #1116, M-1).
 */
export function commandInputHash(def: Pick<ActionDef, 'sensitive'>, input: unknown, env?: NodeJS.ProcessEnv) {
  const key = inputHashKey(env)
  return key
    ? createHmac('sha256', key)
        .update(canonicalJson(redactInput(def, input)))
        .digest('hex')
    : null
}
