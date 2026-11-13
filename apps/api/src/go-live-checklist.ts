// The go-live checklist in the inbox (onboarding.goLiveChecklist, onboarding.dismissGoLiveChecklist): the facts the browser
// cannot see in its own store. The rest (numbers, calendars, team, push) it reads from what it already has.
// Owners and admins only (settings:write, checked by the registry); a member's dismissal is their own row.
// Steps set aside (golive_checklist_steps): "Not needed" is the workspace's for a workspace-scoped step and the
// caller's own for a person-scoped one (goLiveStepScope); "Remind me" is always the caller's own.
// Live (firstRealCall) is the shared definition (isLive, @linedesk/actions setup-state.ts), as in the setup emails.
import {
  type GoLiveChecklistData,
  type GoLiveStep,
  type GoLiveStepState,
  goLiveStepScope,
  goLiveSteps,
  isLive,
  liveMilestones,
  skippableGoLiveSteps,
} from '@linedesk/actions'
import {
  golive_checklist_dismissals,
  golive_checklist_steps,
  setup_events,
  type Tx,
  workspace_settings,
} from '@linedesk/db'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { type Handler, Reject } from './handler-context.ts'

/** A person in a workspace, not the voice agent: only people see and close the checklist. */
function memberOf(actor: Actor): { workspaceId: string; userId: string } {
  if (!actor.workspaceId || actor.role === 'agent') throw new Reject('no workspace')
  return { workspaceId: actor.workspaceId, userId: actor.actorId }
}

export async function goLiveChecklist(tx: Tx, actor: Actor): Promise<GoLiveChecklistData> {
  const { workspaceId, userId } = memberOf(actor)
  const [settings] = await tx
    .select({ step: workspace_settings.onboarding_step })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  const events = await tx
    .select({ event: setup_events.event })
    .from(setup_events)
    .where(
      and(
        eq(setup_events.workspace_id, workspaceId),
        inArray(setup_events.event, ['forwarding_verified', ...liveMilestones]),
      ),
    )
  const [dismissal] = await tx
    .select({ at: golive_checklist_dismissals.dismissed_at })
    .from(golive_checklist_dismissals)
    .where(
      and(eq(golive_checklist_dismissals.workspace_id, workspaceId), eq(golive_checklist_dismissals.user_id, userId)),
    )
  const reached = new Set(events.map(e => e.event))
  return {
    // Workspaces from before onboarding (no step) were set up by hand and never get it.
    shown: settings?.step === 'done' || settings?.step === 'skipped',
    forwardingVerified: reached.has('forwarding_verified') || (await forwardedCallArrived(tx, workspaceId)),
    // isLive; the calls are only looked at when no milestone says so already.
    firstRealCall: isLive(reached, false) || (await realCallArrived(tx, workspaceId)),
    dismissed: Boolean(dismissal),
    steps: await stepStates(tx, workspaceId, userId),
  }
}

const DAY_MS = 86_400_000
const newId = () => `gls_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/**
 * The workspace's rows and the caller's own: skipped steps (workspace-wide, or the caller's for their own steps) and
 * later steps (also those already passed: the browser compares).
 */
async function stepStates(tx: Tx, workspaceId: string, userId: string): Promise<GoLiveStepState[]> {
  const rows = await tx
    .select({
      step: golive_checklist_steps.step,
      state: golive_checklist_steps.state,
      until: golive_checklist_steps.until,
      user_id: golive_checklist_steps.user_id,
    })
    .from(golive_checklist_steps)
    .where(
      and(
        eq(golive_checklist_steps.workspace_id, workspaceId),
        or(isNull(golive_checklist_steps.user_id), eq(golive_checklist_steps.user_id, userId)),
      ),
    )
  return (
    rows
      .filter((r): r is typeof r & { step: GoLiveStep } => (goLiveSteps as readonly string[]).includes(r.step))
      // A row that does not match its step's scope (one written before the step changed scope) says nothing.
      .filter(r => r.state === 'later' || (r.user_id === null) === (goLiveStepScope[r.step] === 'workspace'))
      // A skipped row for a step that can no longer be skipped (the number, from before it became required) says nothing.
      .filter(r => r.state === 'later' || (skippableGoLiveSteps as readonly string[]).includes(r.step))
      .map(r => ({ step: r.step, state: r.state, until: r.until ? new Date(r.until).toISOString() : null }))
  )
}

/** Whose "Not needed" a step is: null for the whole workspace, else the caller's own. */
const skipOwner = (step: GoLiveStep, userId: string) => (goLiveStepScope[step] === 'person' ? userId : null)

/** The caller's own later row for a step. */
const ownLater = (workspaceId: string, userId: string, step: string) =>
  and(
    eq(golive_checklist_steps.workspace_id, workspaceId),
    eq(golive_checklist_steps.step, step),
    eq(golive_checklist_steps.state, 'later'),
    eq(golive_checklist_steps.user_id, userId),
  )

/**
 * Whether a real caller's call (isRealCall: incoming over the phone, not the business's own phones, not spam) is among
 * the workspace's calls: for workspaces from before the setup milestones were recorded.
 */
async function realCallArrived(tx: Tx, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ yes: boolean }>(sql`select exists (
    select 1 from calls c where c.workspace_id = ${workspaceId} and c.source = 'phone' and c.direction = 'in'
      and not c.from_own_number and c.outcome is distinct from 'spam') as yes`)
  return rows[0]?.yes === true
}

/** Whether a real caller (not the business's own phones) reached one of its numbers that is in a forwarding mode. */
async function forwardedCallArrived(tx: Tx, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ yes: boolean }>(sql`select exists (
    select 1 from calls c join phone_numbers p on p.e164 = c.to_number and p.workspace_id = c.workspace_id
    where c.workspace_id = ${workspaceId} and c.source = 'phone' and not c.from_own_number
      and p.mode in ('forward_conditional', 'forward_all')) as yes`)
  return rows[0]?.yes === true
}

export const goLiveChecklistHandlers: Record<string, Handler> = {
  'onboarding.goLiveChecklist': async ({ tx, actor }) => ({
    rows: {},
    data: await goLiveChecklist(tx, actor),
  }),

  'onboarding.dismissGoLiveChecklist': async ({ tx, actor, now }) => {
    const { workspaceId, userId } = memberOf(actor)
    await tx
      .insert(golive_checklist_dismissals)
      .values({ workspace_id: workspaceId, user_id: userId, dismissed_at: now })
      .onConflictDoNothing()
    return { rows: {} }
  },

  // "Not needed": for the whole workspace, or only for the caller when the step is about their own devices.
  // The registry's Zod already refuses the number and the first real call; this guards the handler too.
  'onboarding.skipGoLiveStep': async ({ tx, actor }, { step }: { step: GoLiveStep }) => {
    const { workspaceId, userId } = memberOf(actor)
    if (!(skippableGoLiveSteps as readonly string[]).includes(step)) throw new Reject('this step cannot be skipped')
    await tx
      .insert(golive_checklist_steps)
      .values({
        id: newId(),
        workspace_id: workspaceId,
        step,
        state: 'skipped',
        user_id: skipOwner(step, userId),
        until: null,
        by_user_id: userId,
      })
      .onConflictDoNothing()
    return { rows: {} }
  },

  // "Remind me": the caller's own; a second reminder for the same step moves its date.
  'onboarding.remindGoLiveStep': async ({ tx, actor, now }, { step, days }: { step: string; days: number }) => {
    const { workspaceId, userId } = memberOf(actor)
    await tx.delete(golive_checklist_steps).where(ownLater(workspaceId, userId, step))
    await tx.insert(golive_checklist_steps).values({
      id: newId(),
      workspace_id: workspaceId,
      step,
      state: 'later',
      user_id: userId,
      until: new Date(new Date(now).getTime() + days * DAY_MS).toISOString(),
      by_user_id: userId,
    })
    return { rows: {} }
  },

  // Back into the open steps: the step's "Not needed" (the workspace's, or the caller's own for a person-scoped step)
  // and the caller's own reminder. Another admin's reminder, or their own "Not needed" of a person-scoped step, stays theirs.
  'onboarding.restoreGoLiveStep': async ({ tx, actor }, { step }: { step: GoLiveStep }) => {
    const { workspaceId, userId } = memberOf(actor)
    const owner = skipOwner(step, userId)
    await tx
      .delete(golive_checklist_steps)
      .where(
        and(
          eq(golive_checklist_steps.workspace_id, workspaceId),
          eq(golive_checklist_steps.step, step),
          or(
            and(
              eq(golive_checklist_steps.state, 'skipped'),
              owner ? eq(golive_checklist_steps.user_id, owner) : isNull(golive_checklist_steps.user_id),
            ),
            and(eq(golive_checklist_steps.state, 'later'), eq(golive_checklist_steps.user_id, userId)),
          ),
        ),
      )
    return { rows: {} }
  },

  'onboarding.reopenGoLiveChecklist': async ({ tx, actor }) => {
    const { workspaceId, userId } = memberOf(actor)
    await tx
      .delete(golive_checklist_dismissals)
      .where(
        and(eq(golive_checklist_dismissals.workspace_id, workspaceId), eq(golive_checklist_dismissals.user_id, userId)),
      )
    return { rows: {} }
  },
}
