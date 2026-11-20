// Where Linedesk Cloud serves businesses: only in the sign-up countries (SIGNUP_COUNTRIES, the
// same on every install). The rule holds for a workspace on a Cloud bill (kind `cloud`, made by self-serve sign-up);
// a workspace a server admin made, a white-label client and every workspace of an install that does not bill keep
// every country. Sign-up checks where the request comes from, the Business step and Workspace settings › General
// offer only these countries, workspace.updateSettings refuses another one, and Checkout refuses a workspace whose
// country is another one. A server admin sets per country who may pick it (signup-access.ts): open to everyone, only
// invited addresses, or off; Germany joins, for invited addresses by default.
import { billing_accounts, organization, type Tx, user } from '@linedesk/db'
import { SOURCE, UI_LOCALES } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { eq } from 'drizzle-orm'
import { uiLocaleOf } from './email-locale.ts'
import { Reject } from './handler-context.ts'
import { accessCountriesFor } from './signup-access.ts'
import { workspaceLocale } from './workspace-locale.ts'

/** The code of the refusal, so the sign-up page shows its "not yet" screen. */
export const COUNTRY_NOT_SERVED = 'country_not_served'

/** The countries a sign-up with this address may pick, by each country's sign-up mode (signup-access.ts). */
export async function signupCountriesFor(tx: Pick<Tx, 'select'>, email: string | null): Promise<readonly string[]> {
  return accessCountriesFor(tx, email)
}

/** "Not available in this country yet", for a country a sign-up may not pick. */
export const countryNotYet = () => Reject.t('server.api.signup.countryNotYet', undefined, COUNTRY_NOT_SERVED)

/**
 * The countries a workspace may be in: on a Cloud bill the ones its bill's owner may pick (signupCountriesFor); else
 * null (every country).
 */
export async function servedCountriesOf(tx: Tx, workspaceId: string): Promise<readonly string[] | null> {
  const [row] = await tx
    .select({ kind: billing_accounts.kind, email: user.email })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .leftJoin(user, eq(user.id, billing_accounts.owner_user_id))
    .where(eq(organization.id, workspaceId))
  return row?.kind === 'cloud' ? signupCountriesFor(tx, row.email ?? null) : null
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

/**
 * Checkout of a Cloud bill: every workspace on it must be in a country its owner may pick, as set, else as worked out.
 */
export async function refuseUnservedWorkspaces(tx: Tx, billId: string): Promise<void> {
  const workspaces = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  for (const w of workspaces) {
    const served = await servedCountriesOf(tx, w.id)
    if (!served) continue
    if (!served.includes((await workspaceLocale(tx, w.id)).resolvedCountry)) throw countryNotYet()
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
