// A white-label partner's own setup with an AI agent (agent-first, 2026-11-18; docs/white-label.md): after the
// partner's Checkout the owner lands on the agent page (scope "partner"), and the agent goes through the partner's own
// steps (its company name, brand and team), then each client workspace's setup. Adding a client workspace adds a seat to
// the partner bill, so it is the owner's own row on the page, never the agent's. partners.setup_step keeps how far the
// partner's part got (partner.setSetupStep), like onboarding_step for a workspace.
import { type PartnerSetupStep, partnerSetupSteps } from '@linedesk/actions'
import {
  billing_accounts,
  organization,
  partner_branding,
  partner_invitations,
  partner_members,
  partners,
  type Tx,
} from '@linedesk/db'
import { and, count, eq, gt, isNull } from 'drizzle-orm'
import { billingRules } from './billing-rules.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, type Handler } from './handler-context.ts'
import { NOT_ON_PARTNER_TEAM, PARTNER_OWNER_ONLY, PARTNER_SUSPENDED } from './partner-refusals.ts'

/** Whether the partner's part went past `step` (never moved back, like onboarding.setStep). */
export const partnerPast = (current: string | null | undefined, step: PartnerSetupStep) =>
  partnerSetupSteps.indexOf(current as PartnerSetupStep) > partnerSetupSteps.indexOf(step)

/** What the partner's own part looks like now: the facts its steps are made of. */
export type PartnerSetupFacts = {
  id: string
  name: string
  status: string
  step: PartnerSetupStep | null
  brandSaved: boolean
  brandName: string | null
  /** Team members besides the owner, and open invitations. */
  team: number
  clients: { id: string; name: string }[]
  /** The plan fee per client workspace (a seat on the partner bill), a month, in cents before tax; null without billing. */
  seat: { cents: number; interval: 'month' | 'year' } | null
}

export async function partnerSetupFacts(partnerId: string, tx: Tx | typeof db = db): Promise<PartnerSetupFacts | null> {
  const [partner] = await tx.select().from(partners).where(eq(partners.id, partnerId))
  if (!partner) return null
  const [brand] = await tx
    .select({ name: partner_branding.name })
    .from(partner_branding)
    .where(eq(partner_branding.partner_id, partnerId))
  const [members] = await tx
    .select({ n: count() })
    .from(partner_members)
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.role, 'admin')))
  const [invited] = await tx
    .select({ n: count() })
    .from(partner_invitations)
    .where(
      and(
        eq(partner_invitations.partner_id, partnerId),
        isNull(partner_invitations.accepted_at),
        gt(partner_invitations.expires_at, new Date().toISOString()),
      ),
    )
  const clients = await tx
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(and(eq(organization.partnerId, partnerId), isNull(organization.disabledAt)))
    .orderBy(organization.createdAt)
  return {
    id: partner.id,
    name: partner.name,
    status: partner.status,
    step: partner.setup_step,
    brandSaved: Boolean(brand),
    brandName: brand?.name ?? null,
    team: (members?.n ?? 0) + (invited?.n ?? 0),
    clients,
    seat: await seatPrice(tx, partner.billing_account_id),
  }
}

/** The price of one more client workspace on the partner bill, at the bill's interval; null where billing is off. */
async function seatPrice(tx: Tx | typeof db, billId: string | null): Promise<PartnerSetupFacts['seat']> {
  if (!billId) return null
  const [bill] = await tx
    .select({ interval: billing_accounts.interval })
    .from(billing_accounts)
    .where(eq(billing_accounts.id, billId))
  if (!bill) return null
  const rules = await billingRules(tx)
  return bill.interval === 'year'
    ? { cents: Math.round(rules.workspaceYearlyCents / 12), interval: 'year' }
    : { cents: rules.workspaceMonthlyCents, interval: 'month' }
}

/** The partner's owner, of a partner that is not suspended (the partner row locked for the change). */
async function partnerOwnerFor(tx: Tx, actor: Actor, partnerId: string) {
  await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update')
  const [row] = await tx
    .select({ step: partners.setup_step, status: partners.status, role: partner_members.role })
    .from(partner_members)
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.user_id, actor.actorId)))
  if (!row) throw new Forbidden(NOT_ON_PARTNER_TEAM)
  if (row.role !== 'owner') throw new Forbidden(PARTNER_OWNER_ONLY)
  if (row.status === 'suspended') throw new Forbidden(PARTNER_SUSPENDED)
  return row
}

export const partnerSetupHandlers: Record<string, Handler> = {
  'partner.setSetupStep': async ({ tx, actor, now }, input: { partnerId: string; step: PartnerSetupStep }) => {
    const row = await partnerOwnerFor(tx, actor, input.partnerId)
    // Never back: a later step stays (the agent of another session may be further).
    if (row.step && !partnerPast(input.step, row.step) && row.step !== input.step)
      return { rows: {}, data: { step: row.step } }
    await tx.update(partners).set({ setup_step: input.step, updated_at: now }).where(eq(partners.id, input.partnerId))
    return { rows: {}, data: { step: input.step } }
  },
}
