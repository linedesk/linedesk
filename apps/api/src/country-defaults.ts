// The settings that follow the workspace's country until someone sets them by hand (workspace_settings
// timezone_follows_country, job_value_currency_follows_country): the time zone and the appointment value's currency.
// They are stored as they apply, so every reader (bookings, hours, Insights, the voice agent) reads one column; this
// moves them whenever the country in use may have changed (the country set or cleared, a number connected, a holiday
// calendar set), and puts one back to following ("Use country default" in Workspace settings › General).
import {
  currencyOfCountry,
  JOB_VALUE_MAX_CENTS,
  mainTimeZoneOf,
  rescaleMinorUnits,
  workspaceTimeZoneFor,
} from '@linedesk/actions'
import { type Tx, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { syncDerivedDays } from './public-holidays.ts'
import { workspaceLocale } from './workspace-locale.ts'

type Row = typeof workspace_settings.$inferSelect

/**
 * What the following settings are for `country`: the time zone kept when it is in that country, else the country's
 * main zone (workspaceTimeZoneFor); the country's currency, with a value set moved to its minor units ($350 → €350).
 * `reset`: the time zone goes to the country's main zone even when the one it has is in the country.
 */
export function countryDefaultsFor(
  row: Pick<
    Row,
    | 'timezone'
    | 'timezone_follows_country'
    | 'job_value_cents'
    | 'job_value_currency'
    | 'job_value_currency_follows_country'
  >,
  country: string,
  reset: { timeZone?: boolean } = {},
): Partial<Pick<Row, 'timezone' | 'job_value_cents' | 'job_value_currency'>> {
  const change: Partial<Pick<Row, 'timezone' | 'job_value_cents' | 'job_value_currency'>> = {}
  if (row.timezone_follows_country) {
    const zone =
      (reset.timeZone ? mainTimeZoneOf(country) : workspaceTimeZoneFor(country, row.timezone)) ?? row.timezone
    if (zone !== row.timezone) change.timezone = zone
  }
  const currency = row.job_value_currency_follows_country ? currencyOfCountry(country) : null
  if (currency && currency !== row.job_value_currency) {
    const cents =
      row.job_value_cents === null ? null : rescaleMinorUnits(row.job_value_cents, row.job_value_currency, currency)
    // A value too large in the new currency's minor units keeps its currency (a rare case: a huge value in yen).
    if (cents === null || cents <= JOB_VALUE_MAX_CENTS) {
      change.job_value_currency = currency
      if (cents !== null && cents !== row.job_value_cents) change.job_value_cents = cents
    }
  }
  return change
}

/**
 * Moves the settings that follow the country to the country in use now. Run after anything that can change it; does
 * nothing for a workspace without a settings row or with nothing to move.
 */
export async function applyCountryDefaults(tx: Tx, workspaceId: string, reset: { timeZone?: boolean } = {}) {
  const [row] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  if (!row) return
  const { resolvedCountry } = await workspaceLocale(tx, workspaceId, row)
  const change = countryDefaultsFor(row, resolvedCountry, reset)
  if (!Object.keys(change).length) return
  await tx.update(workspace_settings).set(change).where(eq(workspace_settings.workspace_id, workspaceId))
  // A new time zone moves "today", from which the holidays and yearly days are kept.
  if (change.timezone) await syncDerivedDays(tx, workspaceId)
}
