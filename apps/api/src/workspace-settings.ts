// Workspace settings that live in workspace_settings (not synced to browsers): read and change them
// through the registry. One row per workspace; a workspace without one gets it on the first change.
import {
  type ClosedDay,
  DEFAULT_RECORDING_NOTICE,
  DEFAULT_RECORDING_RETENTION_DAYS,
  JOB_VALUE_MAX_CENTS,
  type JobValueCurrency,
  type PickupMode,
  currencyOfCountry,
  rescaleMinorUnits,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Closure } from '@linedesk/db/types'
import { availability_exceptions, availability_rules, organization, type Tx, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { derivedDaysOf, syncDerivedDays } from './public-holidays.ts'
import { activeProvider } from './provider-settings.ts'
import { deleteOwn, deletePreview } from './workspace-delete-own.ts'
import { workspaceLocale } from './workspace-locale.ts'

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
    const locale = await workspaceLocale(tx, actor.workspaceId, row ?? null)
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
      holidays: row?.holidays ?? null,
      derivedDays: await derivedDaysOf(tx, actor.workspaceId, row?.timezone ?? DEFAULT_TIME_ZONE),
      closure: row?.closure ?? null,
      jobValueCents: row?.job_value_cents ?? null,
      jobValueCurrency: jobValueCurrencyOf(row, locale.resolvedCountry),
      pickupMode: row?.pickup_mode ?? null,
      ...locale,
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

  /** An owner deletes their own workspace (workspace-delete-own.ts); the preview is what its dialog shows first. */
  'workspace.deleteOwn': deleteOwn,
  'workspace.deletePreview': deletePreview,

  'workspace.updateSettings': async (
    { tx, actor },
    input: {
      recordingRetentionDays?: number | null
      businessHoursOn?: boolean
      recordingNoticeOn?: boolean
      recordingNotice?: string
      timeZone?: string
      closure?: Closure | null
      jobValueCents?: number | null
      jobValueCurrency?: JobValueCurrency
      pickupMode?: PickupMode
      country?: string | null
      language?: string | null
    },
  ) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const jobValueCents =
      input.jobValueCents === undefined && input.jobValueCurrency !== undefined
        ? await rescaledJobValue(tx, actor.workspaceId, input.jobValueCurrency)
        : input.jobValueCents
    const set = {
      ...(input.recordingRetentionDays !== undefined ? { recording_retention_days: input.recordingRetentionDays } : {}),
      ...(input.businessHoursOn !== undefined ? { business_hours_on: input.businessHoursOn } : {}),
      ...(input.recordingNoticeOn !== undefined ? { recording_notice_on: input.recordingNoticeOn } : {}),
      ...(input.recordingNotice !== undefined ? { recording_notice: input.recordingNotice } : {}),
      ...(input.timeZone !== undefined ? { timezone: input.timeZone } : {}),
      ...(input.closure !== undefined ? { closure: input.closure } : {}),
      ...(jobValueCents !== undefined ? { job_value_cents: jobValueCents } : {}),
      ...(input.jobValueCurrency !== undefined ? { job_value_currency: input.jobValueCurrency } : {}),
      ...(input.pickupMode !== undefined ? { pickup_mode: input.pickupMode } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
    }
    if (!Object.keys(set).length) return { rows: {} }
    const [row] = await tx
      .insert(workspace_settings)
      .values({ workspace_id: actor.workspaceId, timezone: DEFAULT_TIME_ZONE, ...set })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set })
      .returning()
    // A new time zone moves "today", from which the holidays and yearly days are kept.
    if (input.timeZone !== undefined) await syncDerivedDays(tx, actor.workspaceId)
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
        jobValueCurrency: row!.job_value_currency,
        pickupMode: row!.pickup_mode,
        ...(input.country !== undefined || input.language !== undefined
          ? await workspaceLocale(tx, actor.workspaceId, row!)
          : {}),
      } satisfies Pick<
        WorkspaceSettingsData,
        | 'recordingRetentionDays'
        | 'businessHoursOn'
        | 'recordingNoticeOn'
        | 'recordingNotice'
        | 'timeZone'
        | 'closure'
        | 'jobValueCents'
        | 'jobValueCurrency'
        | 'pickupMode'
      > &
        Partial<WorkspaceSettingsData>,
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
    // Only the own days: the holidays and the later years of yearly days are written by syncDerivedDays.
    await tx
      .delete(availability_exceptions)
      .where(and(eq(availability_exceptions.workspace_id, workspace_id), eq(availability_exceptions.source, 'own')))
    if (input.days.length) {
      await tx.insert(availability_exceptions).values(
        input.days.map(d => ({
          id: `ae_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
          workspace_id,
          date: d.date,
          name: d.name,
          start_time: d.start,
          end_time: d.end,
          yearly: d.yearly ?? false,
        })),
      )
    }
    await syncDerivedDays(tx, workspace_id)
    const [settings] = await tx
      .select({ timezone: workspace_settings.timezone })
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, workspace_id))
    return {
      rows: {},
      data: {
        closedDays: await closedDaysOf(tx, workspace_id),
        derivedDays: await derivedDaysOf(tx, workspace_id, settings?.timezone ?? DEFAULT_TIME_ZONE),
      },
    }
  },
}

/** The workspace's own closed days, by date. */
async function closedDaysOf(tx: Tx, workspaceId: string): Promise<ClosedDay[]> {
  const rows = await tx
    .select()
    .from(availability_exceptions)
    .where(and(eq(availability_exceptions.workspace_id, workspaceId), eq(availability_exceptions.source, 'own')))
  return rows
    .map(r => ({
      date: r.date,
      name: r.name,
      start: r.start_time?.slice(0, 5) ?? null,
      end: r.end_time?.slice(0, 5) ?? null,
      yearly: r.yearly,
    }))
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

/**
 * A new currency without a new amount: the stored value moves to the new currency's minor units, so the
 * amount people see stays ($350 → ¥350, not ¥35,000). undefined: nothing stored, or no change needed.
 */
async function rescaledJobValue(tx: Tx, workspaceId: string, to: JobValueCurrency): Promise<number | undefined> {
  const [row] = await tx
    .select({ cents: workspace_settings.job_value_cents, currency: workspace_settings.job_value_currency })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  if (!row || row.cents === null || row.currency === to) return undefined
  const cents = rescaleMinorUnits(row.cents, row.currency, to)
  if (cents > JOB_VALUE_MAX_CENTS)
    throw new Reject(`The appointment value is too large in ${to}; set jobValueCents with it.`)
  return cents
}

/**
 * The currency of the appointment value: the one saved with a value; while no value is set, the currency of the
 * workspace's country (EUR in Germany), so the field starts in the money the business counts in. USD in the US, as before.
 */
function jobValueCurrencyOf(
  row: { job_value_cents: number | null; job_value_currency: JobValueCurrency } | undefined,
  country: string,
): JobValueCurrency {
  if (row && row.job_value_cents !== null) return row.job_value_currency
  return currencyOfCountry(country) ?? row?.job_value_currency ?? 'USD'
}
