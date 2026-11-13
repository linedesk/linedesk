// Workspace settings that live in workspace_settings (not synced to browsers): read and change them
// through the registry. One row per workspace; a workspace without one gets it on the first change.
import { type ClosedDay, DEFAULT_RECORDING_NOTICE, DEFAULT_RECORDING_RETENTION_DAYS, type PickupMode, type WorkspaceSettingsData } from '@linedesk/actions'
import type { Closure } from '@linedesk/db/types'
import { availability_exceptions, availability_rules, organization, type Tx, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { activeProvider } from './provider-settings.ts'

/**
 * Whether calls are recorded on this server: a recording store is picked in the admin area (and set
 * up), or RECORDING_STORE names one. The voice agent gets the same answer from GET /v1/agent/provider-config.
 */
export const recordingOn = async (tx: Tx, env: Record<string, string | undefined> = process.env) =>
  (await activeProvider(tx, 'recording', env).catch(() => null)) !== null

/** Used until a workspace has stored its own time zone (same default as onboarding). */
const DEFAULT_TIME_ZONE = 'America/New_York'

export const workspaceSettingsHandlers: Record<string, Handler> = {
  'workspace.getSettings': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [row] = await tx
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, actor.workspaceId))
    const rules = await tx
      .select()
      .from(availability_rules)
      .where(eq(availability_rules.workspace_id, actor.workspaceId))
    const data: WorkspaceSettingsData = {
      recordingRetentionDays: row ? row.recording_retention_days : DEFAULT_RECORDING_RETENTION_DAYS,
      businessHoursOn: row?.business_hours_on ?? false,
      recordingNoticeOn: row?.recording_notice_on ?? false,
      recordingNotice: row?.recording_notice ?? DEFAULT_RECORDING_NOTICE,
      timeZone: row?.timezone ?? DEFAULT_TIME_ZONE,
      businessHours: rules
        .map(r => ({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) }))
        .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
      recordingOn: await recordingOn(tx),
      closedDays: await closedDaysOf(tx, actor.workspaceId),
      closure: row?.closure ?? null,
      jobValueCents: row?.job_value_cents ?? null,
      pickupMode: row?.pickup_mode ?? null,
    }
    return { rows: {}, data }
  },

  /** The business name is the workspace's (organization) name. */
  'workspace.rename': async ({ tx, actor }, input: { name: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [row] = await tx
      .update(organization)
      .set({ name: input.name })
      .where(eq(organization.id, actor.workspaceId))
      .returning({ id: organization.id, name: organization.name })
    if (!row) throw new Reject('no workspace')
    return { rows: {}, data: row }
  },

  'workspace.updateSettings': async (
    { tx, actor },
    input: { recordingRetentionDays?: number | null; businessHoursOn?: boolean; recordingNoticeOn?: boolean; recordingNotice?: string; timeZone?: string; closure?: Closure | null; jobValueCents?: number | null; pickupMode?: PickupMode },
  ) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const set = {
      ...(input.recordingRetentionDays !== undefined ? { recording_retention_days: input.recordingRetentionDays } : {}),
      ...(input.businessHoursOn !== undefined ? { business_hours_on: input.businessHoursOn } : {}),
      ...(input.recordingNoticeOn !== undefined ? { recording_notice_on: input.recordingNoticeOn } : {}),
      ...(input.recordingNotice !== undefined ? { recording_notice: input.recordingNotice } : {}),
      ...(input.timeZone !== undefined ? { timezone: input.timeZone } : {}),
      ...(input.closure !== undefined ? { closure: input.closure } : {}),
      ...(input.jobValueCents !== undefined ? { job_value_cents: input.jobValueCents } : {}),
      ...(input.pickupMode !== undefined ? { pickup_mode: input.pickupMode } : {}),
    }
    if (!Object.keys(set).length) return { rows: {} }
    const [row] = await tx
      .insert(workspace_settings)
      .values({ workspace_id: actor.workspaceId, timezone: DEFAULT_TIME_ZONE, ...set })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set })
      .returning()
    return {
      rows: {},
      data: {
        recordingRetentionDays: row!.recording_retention_days,
        businessHoursOn: row!.business_hours_on,
        recordingNoticeOn: row!.recording_notice_on,
        recordingNotice: row!.recording_notice ?? DEFAULT_RECORDING_NOTICE,
        timeZone: row!.timezone,
        closure: row!.closure,
        jobValueCents: row!.job_value_cents,
        pickupMode: row!.pickup_mode,
      } satisfies Pick<WorkspaceSettingsData, 'recordingRetentionDays' | 'businessHoursOn' | 'recordingNoticeOn' | 'recordingNotice' | 'timeZone' | 'closure' | 'jobValueCents' | 'pickupMode'>,
    }
  },

  // The weekly hours replace what was there: one list, saved as a whole from Settings › Assistant.
  'businessHours.set': async ({ tx, actor }, input: { hours: { weekday: number; start: string; end: string }[] }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    await tx.delete(availability_rules).where(eq(availability_rules.workspace_id, workspace_id))
    if (input.hours.length) {
      await tx.insert(availability_rules).values(
        input.hours.map(h => ({
          id: `ar_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
          workspace_id,
          weekday: h.weekday,
          start_time: h.start,
          end_time: h.end,
        })),
      )
    }
    return { rows: {} }
  },

  // Holidays and closure days replace what was there, like the weekly hours.
  'closedDays.set': async ({ tx, actor }, input: { days: ClosedDay[] }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    const dates = new Set(input.days.map(d => d.date))
    if (dates.size !== input.days.length) throw new Reject('each date can be in the list once')
    await tx.delete(availability_exceptions).where(eq(availability_exceptions.workspace_id, workspace_id))
    if (input.days.length) {
      await tx.insert(availability_exceptions).values(
        input.days.map(d => ({
          id: `ae_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
          workspace_id,
          date: d.date,
          name: d.name,
          start_time: d.start,
          end_time: d.end,
        })),
      )
    }
    return { rows: {}, data: { closedDays: await closedDaysOf(tx, workspace_id) } }
  },
}

/** The workspace's holidays and closure days, by date. */
async function closedDaysOf(tx: Tx, workspaceId: string): Promise<ClosedDay[]> {
  const rows = await tx.select().from(availability_exceptions).where(eq(availability_exceptions.workspace_id, workspaceId))
  return rows
    .map(r => ({ date: r.date, name: r.name, start: r.start_time?.slice(0, 5) ?? null, end: r.end_time?.slice(0, 5) ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** What the assistant says right after the greeting: the workspace's recording notice, or null when it is off. */
export async function recordingNoticeFor(tx: Tx, workspaceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ on: workspace_settings.recording_notice_on, text: workspace_settings.recording_notice })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  return row?.on ? row.text?.trim() || DEFAULT_RECORDING_NOTICE : null
}
