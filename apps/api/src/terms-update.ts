// A new terms version for existing customers (LIN-420). Sign-up records
// the terms in effect then (the one place they are asked); when TERMS_VERSION changes, every bill's owner accepts the new
// version once, in the app (`/v1/me` `termsUpdate`, then `account.acceptTerms`). Calls, keys and billing go on while
// it waits: only the app asks. A new PRIVACY_VERSION alone asks nobody (the policy is acknowledged, not agreed to);
// the next acceptance records it. Without terms set (a self-hosted install), nothing is asked.
import type { AccountAcceptTermsData } from '@linedesk/actions'
import { billing_accounts, terms_acceptances, type Tx, user } from '@linedesk/db'
import { and, eq, inArray, notExists } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { type LegalTerms, legalTerms, recordAcceptance, TERMS_CHANGED } from './legal-terms.ts'

/**
 * The bills that are a contract or about to be one: waiting for Checkout, from the trial on, a comped one too, and
 * suspended ones (still a customer, only paused). Not canceled ones.
 */
const CONTRACT_STATUSES = ['pending_payment', 'trialing', 'active', 'past_due', 'suspended', 'comped'] as const

/**
 * The bills `userId` owns that have no acceptance of this terms version by them. A bill waiting for Checkout counts
 * too: neither the activation step nor Checkout asks for the terms, so a sign-up made under an
 * older version accepts the new one here first; `billing.startCheckout` is refused until then (billing-checkout.ts).
 */
export async function billsToReaccept(tx: Tx, userId: string, termsVersion: string): Promise<string[]> {
  const bills = await tx
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.owner_user_id, userId),
        inArray(billing_accounts.status, CONTRACT_STATUSES),
        notExists(
          tx
            .select({ id: terms_acceptances.id })
            .from(terms_acceptances)
            .where(
              and(
                eq(terms_acceptances.user_id, userId),
                eq(terms_acceptances.billing_account_id, billing_accounts.id),
                eq(terms_acceptances.terms_version, termsVersion),
              ),
            ),
        ),
      ),
    )
    .orderBy(billing_accounts.created_at)
  return bills.map(b => b.id)
}

/** Only the person, signed in to the app as themselves: never a key, the agent, a setup link or an impersonation. */
const asThemselves = (actor: Actor) =>
  !actor.impersonation &&
  !actor.apiKeyId &&
  !actor.personalKeyId &&
  !actor.setupKeyId &&
  !actor.callId &&
  actor.role !== 'agent' &&
  !!actor.sessionId &&
  // On a white-label partner's address the account's own actions are not offered (request-host.ts).
  actor.permissions.includes('account:own')

/**
 * What `/v1/me` tells the app to ask: the terms in effect when this person owns a bill that has not accepted them,
 * else null (no terms set, nothing owned, already accepted, or not signed in as themselves).
 */
export async function termsUpdateFor(tx: Tx, actor: Actor): Promise<LegalTerms | null> {
  if (!asThemselves(actor)) return null
  const { terms } = legalTerms()
  if (!terms) return null
  return (await billsToReaccept(tx, actor.actorId, terms.termsVersion)).length ? terms : null
}

type AcceptTermsInput = { termsVersion: string; privacyVersion: string }

/** account.acceptTerms: records the versions the dialog showed for every owned bill still waiting for them. */
const acceptTerms: Handler = async ({ tx, actor, now }, input: AcceptTermsInput) => {
  if (!asThemselves(actor)) throw Forbidden.t('server.api.terms.onlyYou')
  // One at a time per person: two tabs accepting at once record each bill once.
  const [me] = await tx.select({ id: user.id }).from(user).where(eq(user.id, actor.actorId)).for('update')
  if (!me) throw Forbidden.t('server.api.terms.onlyYou')
  const { terms } = legalTerms()
  if (!terms) throw Reject.t('server.api.terms.none')
  if (input.termsVersion !== terms.termsVersion || input.privacyVersion !== terms.privacyVersion)
    throw Reject.t('server.api.signup.termsChanged', undefined, TERMS_CHANGED)
  const bills = await billsToReaccept(tx, me.id, terms.termsVersion)
  for (const billId of bills)
    await recordAcceptance(tx, {
      userId: me.id,
      billId,
      sessionId: actor.sessionId!,
      terms,
      now,
      source: 'terms_update',
    })
  return { rows: {}, data: { accepted: bills.length } satisfies AccountAcceptTermsData }
}

export const termsUpdateHandlers: Record<string, Handler> = {
  'account.acceptTerms': acceptTerms,
}
