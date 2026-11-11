// Workspace settings that live in workspace_settings (not synced to browsers): read and change them
// through the registry. One row per workspace; a workspace without one gets it on the first change.
import { DEFAULT_RECORDING_RETENTION_DAYS, type WorkspaceSettingsData } from '@linedesk/actions'
import { availability_rules, type Tx, workspace_settings } from '@linedesk/db'
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
      timeZone: row?.timezone ?? DEFAULT_TIME_ZONE,
      businessHours: rules
        .map(r => ({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) }))
        .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
      recordingOn: await recordingOn(tx),
    }
    return { rows: {}, data }
  },

  'workspace.updateSettings': async (
    { tx, actor },
    input: { recordingRetentionDays?: number | null; businessHoursOn?: boolean },
  ) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const set = {
      ...(input.recordingRetentionDays !== undefined ? { recording_retention_days: input.recordingRetentionDays } : {}),
      ...(input.businessHoursOn !== undefined ? { business_hours_on: input.businessHoursOn } : {}),
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
      } satisfies Pick<WorkspaceSettingsData, 'recordingRetentionDays' | 'businessHoursOn'>,
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
}
