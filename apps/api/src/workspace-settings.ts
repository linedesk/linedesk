// Workspace settings that live in workspace_settings (not synced to browsers): read and change them
// through the registry. One row per workspace; a workspace without one gets it on the first change.
import { DEFAULT_RECORDING_RETENTION_DAYS, type WorkspaceSettingsData } from '@callfront/actions'
import { availability_rules, workspace_settings } from '@callfront/db'
import { eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

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
      timeZone: row?.timezone ?? DEFAULT_TIME_ZONE,
      businessHours: rules
        .map(r => ({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) }))
        .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
    }
    return { rows: {}, data }
  },

  'workspace.updateSettings': async ({ tx, actor }, input: { recordingRetentionDays?: number | null }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    if (input.recordingRetentionDays === undefined) return { rows: {} }
    const recording_retention_days = input.recordingRetentionDays
    await tx
      .insert(workspace_settings)
      .values({ workspace_id: actor.workspaceId, timezone: DEFAULT_TIME_ZONE, recording_retention_days })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { recording_retention_days } })
    return {
      rows: {},
      data: { recordingRetentionDays: recording_retention_days } satisfies Pick<
        WorkspaceSettingsData,
        'recordingRetentionDays'
      >,
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
