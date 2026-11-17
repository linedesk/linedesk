// Workspace settings that live in workspace_settings (not synced to browsers): read and change them
// through the registry. One row per workspace; a workspace without one gets it on the first change.
import {
  type AllowPremiumData,
  type AllowUltraData,
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
import {
  availability_exceptions,
  availability_rules,
  billing_accounts,
  organization,
  type Tx,
  workspace_settings,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { isPartnerOwner, PARTNER_DECIDES_LEVELS } from './partner-refusals.ts'
import { derivedDaysOf, syncDerivedDays } from './public-holidays.ts'
import { activeProvider } from './provider-settings.ts'
import { lockAssistantVersionsOf } from './assistant-versions.ts'
import { refuseUnlessBillOwner } from './billing-owner.ts'
import {
  assistantsBackToStandard,
  assistantsOffUltra,
  levelCentsPerMinute,
  refuseBillingActor,
  usageLevelsBilled,
} from './usage-levels.ts'
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

/**
 * Who switches Allow Premium or Allow Ultra (security review of #1109, M-1): never in a disabled workspace (read only);
 * on, only the bill's owner (or the workspace's owner where there is no bill), also where the bill's owner is only an
 * admin or a member (run-action.ts lets them ask; LIN-440); off, the workspace's owner or the bill's owner. In a white-label client (docs/white-label.md, LIN-440) its partner's owner decides, both ways, and the client's
 * own owner never does: the partner pays and sets what its client may use. Anyone else holding billing:manage here
 * gets 403.
 */
async function refuseAllowSwitch(tx: Tx, actor: Actor, on: boolean) {
  if (actor.workspaceDisabled) throw Reject.t('server.api.workspaceDisabled')
  const [org] = actor.workspaceId
    ? await tx
        .select({ partnerId: organization.partnerId, bill: organization.billingAccountId })
        .from(organization)
        .where(eq(organization.id, actor.workspaceId))
    : []
  if (org?.partnerId) {
    if (!(await isPartnerOwner(tx, org.partnerId, actor.actorId))) throw new Forbidden(PARTNER_DECIDES_LEVELS)
    // A client without a bill: only as its owner, as before LIN-440 let admins and members ask (review of #1140, L-1).
    if (!org.bill && actor.role !== 'owner') throw new Forbidden(PARTNER_DECIDES_LEVELS)
    // On the partner bill, its owner is the partner's owner: checked (and the bill locked) as for every bill.
    if (org.bill) await refuseUnlessBillOwner(tx, actor)
    return
  }
  if (on || actor.role !== 'owner') await refuseUnlessBillOwner(tx, actor)
}

/**
 * What the caller may do with Allow Premium and Allow Ultra here, as refuseAllowSwitch decides it (read without locks,
 * for the settings page: the switch is disabled for anyone it would refuse; LIN-440).
 */
async function allowSwitchOf(tx: Tx, actor: Actor): Promise<{ on: boolean; off: boolean }> {
  const none = { on: false, off: false }
  if (!actor.workspaceId || actor.workspaceDisabled) return none
  if (actor.impersonation || actor.apiKeyId || actor.personalKeyId || actor.setupKeyId) return none
  const [org] = await tx
    .select({
      partnerId: organization.partnerId,
      billId: organization.billingAccountId,
      billOwner: billing_accounts.owner_user_id,
    })
    .from(organization)
    .leftJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, actor.workspaceId))
  // A bill id without its bill: refused by the handler (refuseUnlessBillOwner), so nobody here.
  if (!org || (org.billId && !org.billOwner)) return none
  const ownsBill = org.billId ? org.billOwner === actor.actorId : actor.role === 'owner'
  if (org.partnerId) {
    const may = ownsBill && (await isPartnerOwner(tx, org.partnerId, actor.actorId))
    return { on: may, off: may }
  }
  return { on: ownsBill, off: ownsBill || actor.role === 'owner' }
}

/**
 * Switches Allow Premium or Allow Ultra in a workspace once the caller was allowed to (refuseAllowSwitch, or the
 * partner's owner from Partner › Clients). Off moves the workspace's assistants on a Premium voice or model back to
 * the install's defaults (Premium), or those answering with a realtime model back to the three stages (Ultra), in the
 * same transaction, each with a new version by `actorId`. Locks in the order every save takes them: the version locks
 * of all the workspace's assistants (by id), then the settings row, then the assistant rows. A save running at the
 * same time finishes before or starts after, and the move sees it or it sees the move; never a deadlock.
 */
export async function switchAllowLevel(
  tx: Tx,
  workspaceId: string,
  actorId: string,
  level: 'premium' | 'ultra',
  on: boolean,
) {
  if (!on) await lockAssistantVersionsOf(tx, workspaceId)
  const set = level === 'premium' ? { allow_premium: on } : { allow_ultra: on }
  await tx
    .insert(workspace_settings)
    .values({ workspace_id: workspaceId, timezone: DEFAULT_TIME_ZONE, ...set })
    .onConflictDoUpdate({ target: workspace_settings.workspace_id, set })
  if (on) return []
  return level === 'premium'
    ? await assistantsBackToStandard(tx, workspaceId, actorId)
    : await assistantsOffUltra(tx, workspaceId, actorId)
}

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
      recordingNoticeOn: row?.recording_notice_on ?? true,
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
      allowPremium: row?.allow_premium ?? false,
      allowUltra: row?.allow_ultra ?? false,
      allowSwitch: await allowSwitchOf(tx, actor),
      usageLevels: await usageLevelsBilled(tx),
      // A white-label client's people see minutes, never our prices (docs/white-label.md; review of #1109, L-2).
      ...(partnerManaged ? { partnerManaged } : { usageCentsPerMinute: await levelCentsPerMinute(tx) }),
    }
    return { rows: {}, data }
  },

  /**
   * Allow Premium (Linedesk Cloud): the owner only, as themselves in the app (refuseBillingActor), and when the workspace
   * is on a bill, only its bill's owner switches it on (off costs less, so the workspace owner may); in a white-label
   * client only its partner's owner (refuseAllowSwitch); audited. Off moves Premium assistants back (switchAllowLevel).
   */
  'workspace.setAllowPremium': async ({ tx, actor }, input: { on: boolean }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    refuseBillingActor(actor)
    await refuseAllowSwitch(tx, actor, input.on)
    const moved = await switchAllowLevel(tx, actor.workspaceId, actor.actorId, 'premium', input.on)
    const data: AllowPremiumData = { on: input.on, movedToStandard: moved.map(a => a.id) }
    return { rows: moved.length ? { assistants: moved } : {}, data }
  },

  /**
   * Allow Ultra (Linedesk Cloud): like Allow Premium, the owner only, as themselves in the app, the bill's owner when
   * there is a bill switches it on, and in a white-label client only its partner's owner; audited. Off moves the
   * workspace's assistants that answer with a realtime model back to the three stages (switchAllowLevel).
   */
  'workspace.setAllowUltra': async ({ tx, actor }, input: { on: boolean }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    refuseBillingActor(actor)
    await refuseAllowSwitch(tx, actor, input.on)
    const moved = await switchAllowLevel(tx, actor.workspaceId, actor.actorId, 'ultra', input.on)
    const data: AllowUltraData = { on: input.on, movedOffUltra: moved.map(a => a.id) }
    return { rows: moved.length ? { assistants: moved } : {}, data }
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
        ...(input.country !== undefined ? await workspaceLocale(tx, actor.workspaceId, row!) : {}),
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

/** What the assistant says right after the greeting: the workspace's recording notice (on until the owner turns it off), or null when it is off. */
export async function recordingNoticeFor(tx: Tx, workspaceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ on: workspace_settings.recording_notice_on, text: workspace_settings.recording_notice })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  if (row && !row.on) return null
  return row?.text?.trim() || DEFAULT_RECORDING_NOTICE
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
