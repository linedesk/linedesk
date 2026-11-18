// Where Linedesk Cloud serves businesses (docs/billing.md §3.2): only in the sign-up countries (SIGNUP_COUNTRIES, the
// same on every install). The rule holds for a workspace on a Cloud bill (kind `cloud`, made by self-serve sign-up);
// a workspace a server admin made, a white-label client and every workspace of an install that does not bill keep
// every country. Sign-up checks where the request comes from, the Business step and Workspace settings › General
// offer only these countries, workspace.updateSettings refuses another one, and Checkout refuses a workspace whose
// country is another one.
import { billing_accounts, organization, SIGNUP_COUNTRIES, type Tx } from '@linedesk/db'
import { SOURCE, UI_LOCALES } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { eq } from 'drizzle-orm'
import { uiLocaleOf } from './email-locale.ts'
import { Reject } from './handler-context.ts'
import { workspaceLocale } from './workspace-locale.ts'

/** The code of the refusal, so the sign-up page shows its "not yet" screen. */
export const COUNTRY_NOT_SERVED = 'country_not_served'

export const isServedCountry = (country: string) => (SIGNUP_COUNTRIES as readonly string[]).includes(country)

/** "Not available in this country yet", for a country outside the sign-up countries. */
export const countryNotYet = () => Reject.t('server.api.signup.countryNotYet', undefined, COUNTRY_NOT_SERVED)

/** The countries a workspace may be in: the sign-up countries on a Cloud bill, else null (every country). */
export async function servedCountriesOf(tx: Tx, workspaceId: string): Promise<readonly string[] | null> {
  const [row] = await tx
    .select({ kind: billing_accounts.kind })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspaceId))
  return row?.kind === 'cloud' ? SIGNUP_COUNTRIES : null
}

/**
 * A country set for a workspace (workspace.updateSettings): refused outside the countries it may be in. Automatic
 * (null) and the country it has already are always taken, so a workspace that came to a Cloud bill from elsewhere
 * (it left its partner) keeps saving its other settings.
 */
export async function refuseUnservedCountry(
  tx: Tx,
  workspaceId: string,
  country: string | null,
  current: string | null,
): Promise<void> {
  if (!country || country === current) return
  const served = await servedCountriesOf(tx, workspaceId)
  if (served && !served.includes(country)) throw countryNotYet()
}

/** Checkout of a Cloud bill: every workspace on it must be in a sign-up country (as set, else as worked out). */
export async function refuseUnservedWorkspaces(tx: Tx, billId: string): Promise<void> {
  const workspaces = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  for (const w of workspaces) {
    if (!(await servedCountriesOf(tx, w.id))) continue
    if (!isServedCountry((await workspaceLocale(tx, w.id)).resolvedCountry)) throw countryNotYet()
  }
}

/**
 * The name a workspace made by sign-up has until the Business step names it, in the language of whoever signs up
 * (else English).
 */
export const placeholderWorkspaceName = (locale: string | null | undefined) =>
  getT(uiLocaleOf(locale) ?? SOURCE).t('server.signup.workspaceName')

/** Whether a workspace still has the sign-up placeholder name, in any language (the Business step starts empty). */
export const isPlaceholderWorkspaceName = (name: string) =>
  UI_LOCALES.some(locale => getT(locale).t('server.signup.workspaceName') === name)
