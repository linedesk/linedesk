// Workspace settings that live in workspace_settings (not synced to browsers): read and change them
// through the registry. One row per workspace; a workspace without one gets it on the first change.
import {
  type ClosedDay,
  DEFAULT_RECORDING_RETENTION_DAYS,
  JOB_VALUE_MAX_CENTS,
  type JobValueCurrency,
  type PickupMode,
  type BusinessKind,
  currencyOfCountry,
  isBusinessKind,
  mainTimeZoneOf,
  rescaleMinorUnits,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Closure } from '@linedesk/db/types'
import { availability_exceptions, availability_rules, organization, type Tx, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { derivedDaysOf, syncDerivedDays } from './public-holidays.ts'
import { activeProvider } from './provider-settings.ts'
import { levelCentsPerMinute, usageLevelsBilled } from './usage-levels.ts'
import { deleteOwn, deletePreview } from './workspace-delete-own.ts'
import { followWorkspaceLanguage } from './voices.ts'
import { workspaceLocale } from './workspace-locale.ts'
import { applyCountryDefaults } from './country-defaults.ts'
import { refuseUnservedCountry, servedCountriesOf } from './served-countries.ts'

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
    const [org] = await tx
      .select({ partnerId: organization.partnerId })
      .from(organization)
      .where(eq(organization.id, actor.workspaceId))
    const partnerManaged = !!org?.partnerId
    const data: WorkspaceSettingsData = {
      recordingRetentionDays: row ? row.recording_retention_days : DEFAULT_RECORDING_RETENTION_DAYS,
      businessHoursOn: row?.business_hours_on ?? false,
      timeZone: row?.timezone ?? DEFAULT_TIME_ZONE,
      timeZoneFollowsCountry: row?.timezone_follows_country ?? true,
      countryTimeZone: mainTimeZoneOf(locale.resolvedCountry),
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
      jobValueCurrencyFollowsCountry: row?.job_value_currency_follows_country ?? true,
      countryCurrency: currencyOfCountry(locale.resolvedCountry),
      pickupMode: row?.pickup_mode ?? null,
      businessKind: isBusinessKind(row?.business_kind) ? row.business_kind : null,
      ...locale,
      servedCountries: await servedCountriesOf(tx, actor.workspaceId),
      usageLevels: await usageLevelsBilled(tx),
      // A white-label client's people see minutes, never our prices (docs/white-label.md; review of #1109, L-2).
      ...(partnerManaged ? { partnerManaged } : { usageCentsPerMinute: await levelCentsPerMinute(tx) }),
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
      timeZone?: string | null
      closure?: Closure | null
      jobValueCents?: number | null
      jobValueCurrency?: JobValueCurrency | null
      pickupMode?: PickupMode
      country?: string | null
      language?: string | null
      businessKind?: BusinessKind
    },
  ) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    if (input.country !== undefined) {
      const [current] = await tx
        .select({ country: workspace_settings.country })
        .from(workspace_settings)
        .where(eq(workspace_settings.workspace_id, actor.workspaceId))
      await refuseUnservedCountry(tx, actor.workspaceId, input.country, current?.country ?? null)
    }
    // A currency picked is set by hand; null goes back to the country's (applyCountryDefaults below).
    const jobValueCents =
      input.jobValueCents === undefined && input.jobValueCurrency
        ? await rescaledJobValue(tx, actor.workspaceId, input.jobValueCurrency)
        : input.jobValueCents
    // A value typed without a currency is in the currency the field showed (the country's, while it follows).
    const typedIn =
      input.jobValueCents !== undefined && input.jobValueCurrency === undefined
        ? await shownJobValueCurrency(tx, actor.workspaceId)
        : undefined
    const set = {
      ...(input.recordingRetentionDays !== undefined ? { recording_retention_days: input.recordingRetentionDays } : {}),
      ...(input.businessHoursOn !== undefined ? { business_hours_on: input.businessHoursOn } : {}),
      // A time zone picked is set by hand and stays when the country changes; null follows the country again.
      ...(input.timeZone ? { timezone: input.timeZone, timezone_follows_country: false } : {}),
      ...(input.timeZone === null ? { timezone_follows_country: true } : {}),
      ...(input.closure !== undefined ? { closure: input.closure } : {}),
      ...(jobValueCents !== undefined ? { job_value_cents: jobValueCents } : {}),
      ...(input.jobValueCurrency
        ? { job_value_currency: input.jobValueCurrency, job_value_currency_follows_country: false }
        : {}),
      ...(input.jobValueCurrency === null ? { job_value_currency_follows_country: true } : {}),
      ...(typedIn ? { job_value_currency: typedIn } : {}),
      ...(input.pickupMode !== undefined ? { pickup_mode: input.pickupMode } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.businessKind !== undefined ? { business_kind: input.businessKind } : {}),
    }
    if (!Object.keys(set).length) return { rows: {} }
    // The language calls are answered in before the country changes: an untouched default voice follows it (below).
    const languageBefore =
      input.country !== undefined ? (await workspaceLocale(tx, actor.workspaceId)).resolvedLanguage : null
    const [upserted] = await tx
      .insert(workspace_settings)
      .values({ workspace_id: actor.workspaceId, timezone: DEFAULT_TIME_ZONE, ...set })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set })
      .returning()
    // A new time zone moves "today", from which the holidays and yearly days are kept.
    if (input.timeZone) await syncDerivedDays(tx, actor.workspaceId)
    // What follows the country moves with it: a new country, or a setting put back to following ("Use country
    // default": the country's main time zone, its currency).
    const follow = input.country !== undefined || input.timeZone === null || input.jobValueCurrency === null
    if (follow) await applyCountryDefaults(tx, actor.workspaceId, { timeZone: input.timeZone === null })
    const [row] = follow
      ? await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, actor.workspaceId))
      : [upserted]
    const locale = input.country !== undefined ? await workspaceLocale(tx, actor.workspaceId, row!) : null
    const followed =
      locale && languageBefore
        ? await followWorkspaceLanguage(tx, actor.workspaceId, languageBefore, locale.resolvedLanguage)
        : []
    return {
      rows: followed.length ? { assistants: followed } : {},
      data: {
        recordingRetentionDays: row!.recording_retention_days,
        businessHoursOn: row!.business_hours_on,
        timeZone: row!.timezone,
        timeZoneFollowsCountry: row!.timezone_follows_country,
        closure: row!.closure,
        jobValueCents: row!.job_value_cents,
        jobValueCurrency: row!.job_value_currency,
        jobValueCurrencyFollowsCountry: row!.job_value_currency_follows_country,
        pickupMode: row!.pickup_mode,
        businessKind: isBusinessKind(row!.business_kind) ? row!.business_kind : null,
        ...(locale ?? {}),
      } satisfies Pick<
        WorkspaceSettingsData,
        | 'recordingRetentionDays'
        | 'businessHoursOn'
        | 'timeZone'
        | 'timeZoneFollowsCountry'
        | 'closure'
        | 'jobValueCents'
        | 'jobValueCurrency'
        | 'jobValueCurrencyFollowsCountry'
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

/** The currency the appointment value field shows now (jobValueCurrencyOf); undefined without a settings row. */
async function shownJobValueCurrency(tx: Tx, workspaceId: string): Promise<JobValueCurrency | undefined> {
  const [row] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  if (!row) return undefined
  return jobValueCurrencyOf(row, (await workspaceLocale(tx, workspaceId, row)).resolvedCountry)
}

/**
 * The currency of the appointment value: the one picked by hand, or saved with a value; while it follows the country
 * and no value is set, the currency of the country in use (EUR in Germany), also when that country is worked out
 * (applyCountryDefaults stores it when a value is set or the country changes). USD in the US.
 */
function jobValueCurrencyOf(
  row:
    | {
        job_value_cents: number | null
        job_value_currency: JobValueCurrency
        job_value_currency_follows_country: boolean
      }
    | undefined,
  country: string,
): JobValueCurrency {
  if (row && (row.job_value_cents !== null || !row.job_value_currency_follows_country)) return row.job_value_currency
  return currencyOfCountry(country) ?? row?.job_value_currency ?? 'USD'
}
