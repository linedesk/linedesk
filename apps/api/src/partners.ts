// White-label partners (docs/white-label.md, slice S1): the partner account, its team and its client workspaces.
// A partner is its own row (`partners`), not a workspace. Its team (`partner_members`) are real `admin` members of every
// client workspace (`organization.partner_id`), marked with `member.partner_id`, so every existing tenancy check, read
// sync shape and permission keeps working unchanged: syncPartnerMemberships keeps those memberships equal to "every
// team member in every client workspace" (none while the partner is suspended), in the transaction of each change.
//
// Every partner action names its partner, and partnerFor checks the caller is on that partner's team: a member of one
// partner reaches nothing of another (403). Server admin › Partners creates, approves and suspends partners.
import { createHash, randomBytes } from 'node:crypto'
import {
  type AdminPartner,
  PARTNER_CLIENT_LIMIT_DEFAULT,
  PARTNER_CLIENT_LIMIT_MAX,
  type MyPartner,
  type PartnerBillSummary,
  type PartnerClient,
  type PartnerClientMember,
  type PartnerData,
  type PartnerInvitationView,
  type PartnerRole,
  type PartnerStatus,
} from '@linedesk/actions'
import {
  billing_accounts,
  call_reservations,
  calls,
  instance_settings,
  invitation,
  member,
  organization,
  PARTNER_INVITATION_DAYS,
  partner_invitations,
  partner_members,
  partners,
  type Tx,
  user,
} from '@linedesk/db'
import { getT } from '@linedesk/i18n/server'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { localeForUserId } from './email-locale.ts'
import { emailSafeName, partnerInvitationEmail } from './emails/templates.ts'
import { Forbidden, type Handler, type HandlerCtx } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { lockExtraCalls } from './extra-calls.ts'
import { lockBalance } from './ledger.ts'
import { forgetMember, inviteToWorkspace } from './memberships.ts'
import { billForNewClient, mirroredState, seatsFollow } from './partner-billing.ts'
import { NOT_ON_PARTNER_TEAM, PARTNER_OWNER_ONLY, PARTNER_SUSPENDED, refusePartner } from './partner-refusals.ts'
import { signupRules } from './self-serve.ts'
import { createRateLimiter } from './rate-limit.ts'
import { cancelSentInvitations } from './team.ts'
import { billPayerChanged, lockForPayerChange } from './usage-levels.ts'
import { insertWorkspace } from './workspace-creation-handlers.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const DAY_MS = 86_400_000

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const newMemberId = () => crypto.randomUUID().replaceAll('-', '')

/** The link in a partner invitation email: the app opens its invitation page (apps/web/src/partner/PartnerInvite.tsx). */
export const partnerInvitationLink = (token: string) => `${WEB_ORIGIN}/#partner-invite=${token}`

const allowEmailFor = createRateLimiter({ max: 30, windowMs: 3_600_000 })
const allowEmailTo = createRateLimiter({ max: 3, windowMs: 3_600_000 })

type PartnerRow = typeof partners.$inferSelect

/**
 * The partner `partnerId` for a caller on its team, with their role there. Not on the team (another partner's member,
 * or nobody's): 403, the same answer whether or not the partner exists. `write`: the partner row is locked for the
 * transaction (a suspension or a team change at the same moment waits) and a suspended partner changes nothing.
 * `owner`: only the partner's owner.
 */
async function partnerFor(
  tx: Tx,
  actor: Actor,
  partnerId: string,
  need: { write?: boolean; owner?: boolean } = {},
): Promise<{ partner: PartnerRow; role: PartnerRole }> {
  if (need.write) await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update')
  const [row] = await tx
    .select({ partner: partners, role: partner_members.role })
    .from(partner_members)
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.user_id, actor.actorId)))
  if (!row) throw new Forbidden(NOT_ON_PARTNER_TEAM)
  if (need.write && row.partner.status === 'suspended') throw new Forbidden(PARTNER_SUSPENDED)
  if (need.owner && row.role !== 'owner') throw new Forbidden(PARTNER_OWNER_ONLY)
  return row
}

/** The partner row, locked, for an instance admin's change. */
async function lockedPartner(tx: Tx, partnerId: string): Promise<PartnerRow> {
  const [row] = await tx.select().from(partners).where(eq(partners.id, partnerId)).for('update')
  if (!row) throw refusePartner('not_found')
  return row
}

/**
 * Makes the partner's memberships in its client workspaces what they must be: every team member an `admin` of every
 * client workspace (marked `member.partner_id`), or none while the partner is suspended. A membership that is no
 * longer wanted is removed with what the workspace keeps of a member (forgetMember: its API keys revoked, its setup
 * links ended), so a removed partner admin loses the workspace and its read sync at once. A team member who is in a
 * client workspace on their own (a membership without `partner_id`, e.g. its owner) keeps that one untouched.
 * Returns how many memberships were added and removed.
 */
export async function syncPartnerMemberships(tx: Tx, partnerId: string, now: string) {
  const [partner] = await tx.select({ status: partners.status }).from(partners).where(eq(partners.id, partnerId))
  const team =
    partner && partner.status !== 'suspended'
      ? (
          await tx
            .select({ userId: partner_members.user_id })
            .from(partner_members)
            .where(eq(partner_members.partner_id, partnerId))
        ).map(r => r.userId)
      : []
  const clients = (
    await tx.select({ id: organization.id }).from(organization).where(eq(organization.partnerId, partnerId))
  ).map(r => r.id)
  const existing = await tx.select().from(member).where(eq(member.partnerId, partnerId))
  let removed = 0
  let invitationsCanceled = 0
  for (const m of existing) {
    if (team.includes(m.userId) && clients.includes(m.organizationId)) continue
    await tx.delete(member).where(eq(member.id, m.id))
    await forgetMember(tx, m.organizationId, m.userId, now)
    // The invitations they sent there end with the membership (each one in the audit log), so one to a second address
    // of their own cannot keep them in the workspace (security review of #1100, M-2).
    invitationsCanceled += await cancelSentInvitations(tx, m.organizationId, m.userId)
    removed++
  }
  const kept = new Set(existing.filter(m => team.includes(m.userId) && clients.includes(m.organizationId)).map(key))
  let added = 0
  for (const organizationId of clients)
    for (const userId of team) {
      if (kept.has(key({ organizationId, userId }))) continue
      // A membership of their own there stays as it is (and the unique index keeps one per person and workspace).
      const inserted = await tx
        .insert(member)
        .values({ id: newMemberId(), organizationId, userId, role: 'admin', createdAt: new Date(now), partnerId })
        .onConflictDoNothing()
        .returning({ id: member.id })
      added += inserted.length
    }
  return { added, removed, invitationsCanceled }
}
const key = (m: { organizationId: string; userId: string }) => `${m.organizationId}/${m.userId}`

/** The partners a person is on the team of, for GET /v1/me and the workspace menu. */
export async function partnersOf(userId: string, tx: Tx | typeof db = db): Promise<MyPartner[]> {
  const rows = await tx
    .select({ id: partners.id, name: partners.name, status: partners.status, role: partner_members.role })
    .from(partner_members)
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(eq(partner_members.user_id, userId))
    .orderBy(asc(partners.name))
  return rows.map(r => ({ ...r, status: r.status as PartnerStatus, role: r.role as PartnerRole }))
}

const CLIENT_LIMIT_KEY = 'partners.client_limit'

/** How many client workspaces a partner may make while billing is off (Server admin › Partners; partner.setClientLimit). */
export async function partnerClientLimit(tx: Tx): Promise<number> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, CLIENT_LIMIT_KEY))
  const limit = Number(row?.value)
  return Number.isInteger(limit) && limit >= 1 && limit <= PARTNER_CLIENT_LIMIT_MAX
    ? limit
    : PARTNER_CLIENT_LIMIT_DEFAULT
}

/**
 * Whether a pending, unexpired partner invitation to this address exists (of a partner that is not suspended): the
 * address may get an account by an email code, like a workspace invitation (signup-gate.ts).
 */
export async function partnerInvitationFor(tx: Tx, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: partner_invitations.id })
    .from(partner_invitations)
    .innerJoin(partners, eq(partners.id, partner_invitations.partner_id))
    .where(
      and(
        eq(partner_invitations.email, email.toLowerCase()),
        isNull(partner_invitations.accepted_at),
        isNull(partner_invitations.canceled_at),
        gt(partner_invitations.expires_at, new Date().toISOString()),
        sql`${partners.status} <> 'suspended'`,
      ),
    )
    .limit(1)
  return !!row
}

/** An open invitation of the partner to the address (not accepted, withdrawn or expired). */
async function openInvitationTo(tx: Tx, partnerId: string, email: string, now: string) {
  const [row] = await tx
    .select({ id: partner_invitations.id })
    .from(partner_invitations)
    .where(
      and(
        eq(partner_invitations.partner_id, partnerId),
        eq(partner_invitations.email, email),
        isNull(partner_invitations.accepted_at),
        isNull(partner_invitations.canceled_at),
        gt(partner_invitations.expires_at, now),
      ),
    )
  return row ?? null
}

/**
 * Whether the address owns one of the partner's client workspaces, or holds an open owner invitation to one: such a
 * person never joins the partner team (the client's owner is the client's own person; security review of #1109, L-3).
 */
async function ownsClientByEmail(tx: Tx, partnerId: string, email: string) {
  const address = email.toLowerCase()
  const [owner] = await tx
    .select({ id: member.id })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(organization.partnerId, partnerId), eq(member.role, 'owner'), sql`lower(${user.email}) = ${address}`))
  if (owner) return true
  const [invited] = await tx
    .select({ id: invitation.id })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        eq(organization.partnerId, partnerId),
        eq(invitation.role, 'owner'),
        eq(invitation.status, 'pending'),
        sql`lower(${invitation.email}) = ${address}`,
      ),
    )
  return !!invited
}

async function onTeamByEmail(tx: Tx, partnerId: string, email: string) {
  const [row] = await tx
    .select({ id: partner_members.user_id })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .where(and(eq(partner_members.partner_id, partnerId), sql`lower(${user.email}) = ${email}`))
  return !!row
}

/**
 * Makes an invitation and emails its link (only the token's hash is stored). Inside the action's transaction: when the
 * email cannot be sent, nothing is kept.
 */
async function invite(
  tx: Tx,
  partner: { id: string; name: string },
  email: string,
  role: PartnerRole,
  inviterId: string,
  now: string,
) {
  if (emailSender.kind === 'none') throw refusePartner('no_email')
  if (!allowEmailFor(partner.id) || !allowEmailTo(email)) throw refusePartner('invite_limit')
  const token = randomBytes(32).toString('base64url')
  const id = newId('pinv')
  await tx.insert(partner_invitations).values({
    id,
    partner_id: partner.id,
    email,
    role,
    token_hash: hashToken(token),
    invited_by: inviterId,
    expires_at: new Date(Date.parse(now) + PARTNER_INVITATION_DAYS * DAY_MS).toISOString(),
    created_at: now,
  })
  const [inviter] = await tx.select({ name: user.name }).from(user).where(eq(user.id, inviterId))
  const locale = inviter ? await localeForUserId(tx, inviterId) : undefined
  const { t } = getT(locale)
  const content = {
    inviter: emailSafeName(inviter?.name, t('email.fallback.serverAdmin')),
    partner: emailSafeName(partner.name, t('email.fallback.team')),
    email,
    url: partnerInvitationLink(token),
    days: PARTNER_INVITATION_DAYS,
    role,
  }
  try {
    await emailSender.send({ to: email, ...partnerInvitationEmail(content, undefined, locale) })
  } catch (err) {
    console.error('partner invitation email failed', err)
    throw refusePartner('send_failed')
  }
  return id
}

/** An invitation by its link's token, locked; null when there is none. */
async function invitationByToken(tx: Tx, token: string) {
  const [row] = await tx
    .select()
    .from(partner_invitations)
    .where(eq(partner_invitations.token_hash, hashToken(token)))
    .for('update')
  return row ?? null
}

const isOpen = (inv: typeof partner_invitations.$inferSelect, now: string) =>
  !inv.accepted_at && !inv.canceled_at && Date.parse(inv.expires_at) > Date.parse(now)

/** The signed-in person's account (partner invitations are accepted by them only: no impersonation, no key). */
async function me(tx: Tx, actor: Actor) {
  const [account] = await tx.select().from(user).where(eq(user.id, actor.actorId))
  if (!account) throw refusePartner('invitation_invalid')
  return account
}

async function partnerData(
  tx: Tx,
  partner: PartnerRow,
  role: PartnerRole,
  now: string,
  actorId: string,
): Promise<PartnerData> {
  const members = await tx
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: partner_members.role,
      joinedAt: partner_members.created_at,
    })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .where(eq(partner_members.partner_id, partner.id))
    .orderBy(asc(partner_members.created_at))
  // The admins see the team, not who is invited (as a workspace's members do).
  const invitations =
    role === 'owner'
      ? await tx
          .select()
          .from(partner_invitations)
          .where(
            and(
              eq(partner_invitations.partner_id, partner.id),
              isNull(partner_invitations.accepted_at),
              isNull(partner_invitations.canceled_at),
            ),
          )
          .orderBy(asc(partner_invitations.created_at))
      : []
  const clients = await tx
    .select({ id: organization.id, name: organization.name, createdAt: organization.createdAt })
    .from(organization)
    .where(eq(organization.partnerId, partner.id))
    .orderBy(asc(organization.name))
  const people = await clientPeople(
    tx,
    clients.map(c => c.id),
    role === 'owner',
  )
  return {
    partner: { id: partner.id, name: partner.name, status: partner.status as PartnerStatus },
    role,
    members: members.map(m => ({ ...m, role: m.role as PartnerRole })),
    invitations: invitations.map(i => ({
      id: i.id,
      email: i.email,
      role: i.role as PartnerRole,
      expiresAt: i.expires_at,
      expired: Date.parse(i.expires_at) <= Date.parse(now),
    })),
    clients: clients.map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt.toISOString(),
      owner: people.owners.get(c.id) ?? null,
      otherMembers: people.others.get(c.id) ?? [],
    })),
    bill: await billSummary(tx, partner, actorId),
  }
}

/**
 * Per client workspace: its own owner (joined, or invited), and for the partner owner every member who is not there
 * through the partner team, with who invited them (security review of #1100, N-1): who else reads the client's calls.
 */
async function clientPeople(tx: Tx, clientIds: string[], withOthers: boolean) {
  const owners = new Map<string, PartnerClient['owner']>()
  const others = new Map<string, PartnerClientMember[]>()
  if (!clientIds.length) return { owners, others }
  const rows = await tx
    .select({
      workspaceId: member.organizationId,
      name: user.name,
      email: user.email,
      role: member.role,
      invitedBy: sql<string | null>`(
        select coalesce(nullif(sender.name, ''), sender.email) from ${invitation}
        join "user" sender on sender.id = ${invitation.inviterId}
        where ${invitation.organizationId} = ${member.organizationId}
          and lower(${invitation.email}) = lower(${user.email})
          and ${invitation.status} = 'accepted'
        order by ${invitation.createdAt} desc limit 1
      )`,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(inArray(member.organizationId, clientIds), isNull(member.partnerId)))
    .orderBy(asc(member.createdAt))
  for (const r of rows) {
    if (r.role === 'owner') owners.set(r.workspaceId, { name: r.name, email: r.email })
    if (!withOthers) continue
    const role = r.role === 'owner' || r.role === 'admin' ? r.role : 'member'
    others.set(r.workspaceId, [
      ...(others.get(r.workspaceId) ?? []),
      { name: r.name, email: r.email, role, invitedBy: r.invitedBy },
    ])
  }
  const invited = await tx
    .select({ workspaceId: invitation.organizationId, email: invitation.email })
    .from(invitation)
    .where(
      and(
        inArray(invitation.organizationId, clientIds),
        eq(invitation.role, 'owner'),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
      ),
    )
  for (const i of invited) if (!owners.has(i.workspaceId)) owners.set(i.workspaceId, { invited: i.email })
  return { owners, others }
}

/** The partner bill as the partner area shows it; null for a partner without one (billing off, or made by hand). */
async function billSummary(tx: Tx, partner: PartnerRow, actorId: string): Promise<PartnerBillSummary | null> {
  if (!partner.billing_account_id) return null
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, partner.billing_account_id))
  if (!bill) return null
  return {
    status: bill.status,
    trialClientLimit: (await signupRules(tx)).trialWorkspacesPartner,
    mine: bill.owner_user_id === actorId,
  }
}

/** Partner actions file their audit entry under no workspace, with whom the change was about. */
const subject = (email: string | null) => ({ email, workspaceId: null })

type CreateForClientInput = {
  partnerId: string
  name: string
  country?: string
  timeZone?: string
  ownerEmail?: string
}

async function createForClient(ctx: HandlerCtx, input: CreateForClientInput) {
  const { tx, actor, now } = ctx
  const { partner } = await partnerFor(tx, actor, input.partnerId, { write: true, owner: !!input.ownerEmail })
  // Where billing is on, a client workspace goes on the partner bill and adds a seat to its subscription (S2): the
  // bill must run, and in its free trial it takes at most the trial's client workspaces. The bill is the gate there,
  // so a partner waiting for a server admin's approval can try it with its clients (approval gates its brand, S4).
  const bill = await billForNewClient(tx, partner)
  if (!bill) {
    // No billing (self-host, dev): client workspaces only once a server admin approved the partner, and at most the
    // install's ceiling of them (security review of #1100, L-2).
    if (partner.status === 'pending') throw refusePartner('partner_pending')
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(organization)
      .where(eq(organization.partnerId, partner.id))
    if (count >= (await partnerClientLimit(tx))) throw refusePartner('client_limit')
  }
  const org = await insertWorkspace(
    ctx,
    {
      name: input.name,
      ...(input.country ? { country: input.country } : {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    },
    true,
  )
  await tx
    .update(organization)
    .set({
      partnerId: partner.id,
      ...(bill ? { billingAccountId: bill.id, billingState: mirroredState(bill.status) } : {}),
    })
    .where(eq(organization.id, org.id))
  await syncPartnerMemberships(tx, partner.id, now)
  if (input.ownerEmail) await inviteOwner(ctx, partner.id, org, input.ownerEmail)
  if (bill) seatsFollow(ctx.onCommit, bill.id, true, `client_${org.id}`)
  return {
    rows: {},
    // The audit log files the entry under the new workspace.
    data: {
      workspace: { id: org.id, name: org.name },
      billId: bill?.id ?? null,
      ownerInvited: input.ownerEmail ?? null,
      subject: { email: input.ownerEmail ?? null, workspaceId: org.id },
    },
  }
}

/**
 * Only the partner's owner invites a client's owner (createForClient with ownerEmail, workspace.inviteClientOwner): the
 * client's owner can remove the partner and take the workspace, so a partner admin must not hand that to an account of
 * their own. The client's own owner, invited by email to the workspace as its owner (the workspace invitation, so a new address
 * gets its account with an email code, signup-gate.ts). Never someone on the partner team: a partner admin is never
 * a client's owner (docs/white-label.md), else the partner could keep the workspace after the client removed it.
 */
async function inviteOwner(ctx: HandlerCtx, partnerId: string, workspace: { id: string; name: string }, email: string) {
  const { tx, actor, now } = ctx
  if (await onTeamByEmail(tx, partnerId, email)) throw refusePartner('owner_on_team')
  const [owner] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, workspace.id), eq(member.role, 'owner')))
  if (owner) throw refusePartner('client_has_owner')
  await inviteToWorkspace(tx, actor, email, workspace, 'owner', now)
}

/** A client workspace of the partner, or the refusal `client_not_found` (another partner's, or none). */
async function clientOf(tx: Tx, partnerId: string, workspaceId: string) {
  const [org] = await tx
    .select({ id: organization.id, name: organization.name, partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!org || org.partnerId !== partnerId) throw refusePartner('client_not_found')
  return org
}

/** The workspace's name typed again, as the confirmation of removing or releasing a partner. */
function refuseUnconfirmed(name: string, typed: string) {
  if (name.trim().toLowerCase() !== typed.trim().toLowerCase()) throw refusePartner('confirm_mismatch')
}

/**
 * A client workspace leaves its partner (`workspace.removePartner` by its owner, `partner.releaseClient` by the
 * partner's owner; docs/white-label.md): the partner team leaves it at once (memberships removed with their API keys
 * and setup links, the invitations they sent there canceled), and where it was on the partner bill it moves to a new
 * bill of the client's owner waiting for Checkout (`pending_payment`): calls are answered again once they add a card.
 * Allow Premium and Allow Ultra go off (someone else pays now, LIN-438), and the partner's seats drop after the
 * commit. Refused while calls run there (their usage posts to the bill they started on). The caller holds the partner
 * row's lock. Lock order: the partner row, the assistants' version locks, the partner bill's balance, the workspace.
 */
async function detachClient(ctx: HandlerCtx, partnerId: string, workspaceId: string) {
  const { tx, actor, now } = ctx
  const [seen] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (seen?.bill) {
    await lockForPayerChange(tx, [workspaceId])
    await lockBalance(tx, seen.bill)
    // The extra calls leave with the workspace: no extra-calls change on the bill meanwhile (setExtraCalls takes it).
    await lockExtraCalls(tx, seen.bill)
  }
  const [org] = await tx.select().from(organization).where(eq(organization.id, workspaceId)).for('update')
  if (!org || org.partnerId !== partnerId) throw refusePartner('client_not_found')
  if ((org.billingAccountId ?? null) !== (seen?.bill ?? null)) throw refusePartner('client_not_found')
  const [owner] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, org.id), eq(member.role, 'owner')))
  if (!owner) throw refusePartner('client_no_owner')
  let billId: string | null = null
  if (org.billingAccountId) {
    const [running] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(call_reservations)
      .innerJoin(calls, eq(calls.id, call_reservations.call_id))
      .where(eq(calls.workspace_id, org.id))
    if ((running?.n ?? 0) > 0) throw refusePartner('calls_running')
    const [from] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, org.billingAccountId))
    billId = crypto.randomUUID()
    await tx.insert(billing_accounts).values({
      id: billId,
      kind: 'cloud',
      owner_user_id: owner.userId,
      status: 'pending_payment',
      interval: from?.interval ?? 'month',
      created_at: now,
      updated_at: now,
    })
    // Extra calls are bought on a paid plan: the new bill has no subscription yet, so the workspace leaves them behind,
    // as a Server admin move does (security review of #1109, M-2); the partner bill's item drops after the commit.
    await tx
      .update(organization)
      .set({ billingAccountId: billId, billingState: 'pending_payment', extraCalls: 0 })
      .where(eq(organization.id, org.id))
    await billPayerChanged(tx, [org.id], actor.actorId)
    seatsFollow(ctx.onCommit, org.billingAccountId, false, `release_${org.id}`, {
      extraCalls: org.extraCalls > 0 && !!from?.stripe_subscription_id,
    })
  }
  await tx.update(organization).set({ partnerId: null }).where(eq(organization.id, org.id))
  const sync = await syncPartnerMemberships(tx, partnerId, now)
  return {
    workspace: { id: org.id, name: org.name },
    billId,
    removedMemberships: sync.removed,
    invitationsCanceled: sync.invitationsCanceled,
  }
}

export const partnerHandlers: Record<string, Handler> = {
  'partner.get': async ({ tx, actor, now }, input: { partnerId: string }) => {
    const { partner, role } = await partnerFor(tx, actor, input.partnerId)
    return { rows: {}, data: await partnerData(tx, partner, role, now, actor.actorId) }
  },

  'partner.update': async ({ tx, actor, now }, input: { partnerId: string; name: string }) => {
    const { partner } = await partnerFor(tx, actor, input.partnerId, { write: true, owner: true })
    await tx.update(partners).set({ name: input.name, updated_at: now }).where(eq(partners.id, partner.id))
    return { rows: {}, data: { partner: { id: partner.id, name: input.name }, subject: subject(null) } }
  },

  'partnerMember.invite': async ({ tx, actor, now }, input: { partnerId: string; email: string }) => {
    const { partner } = await partnerFor(tx, actor, input.partnerId, { write: true, owner: true })
    if (await onTeamByEmail(tx, partner.id, input.email)) throw refusePartner('already_member')
    if (await openInvitationTo(tx, partner.id, input.email, now)) throw refusePartner('already_invited')
    if (await ownsClientByEmail(tx, partner.id, input.email)) throw refusePartner('client_owner')
    const invitationId = await invite(tx, partner, input.email, 'admin', actor.actorId, now)
    return { rows: {}, data: { invitationId, subject: subject(input.email) } }
  },

  'partnerMember.revokeInvite': async ({ tx, actor, now }, input: { partnerId: string; invitationId: string }) => {
    const { partner } = await partnerFor(tx, actor, input.partnerId, { write: true, owner: true })
    const [row] = await tx
      .update(partner_invitations)
      .set({ canceled_at: now })
      .where(
        and(
          eq(partner_invitations.id, input.invitationId),
          eq(partner_invitations.partner_id, partner.id),
          isNull(partner_invitations.accepted_at),
          isNull(partner_invitations.canceled_at),
        ),
      )
      .returning({ email: partner_invitations.email })
    if (!row) throw refusePartner('invitation_invalid')
    return { rows: {}, data: { subject: subject(row.email) } }
  },

  'partnerMember.remove': async ({ tx, actor, now }, input: { partnerId: string; userId: string }) => {
    const { partner } = await partnerFor(tx, actor, input.partnerId, { write: true, owner: true })
    const [target] = await tx
      .select({ role: partner_members.role, email: user.email })
      .from(partner_members)
      .innerJoin(user, eq(user.id, partner_members.user_id))
      .where(and(eq(partner_members.partner_id, partner.id), eq(partner_members.user_id, input.userId)))
    if (!target) throw refusePartner('member_not_found')
    if (target.role === 'owner') throw refusePartner('owner_stays')
    await tx
      .delete(partner_members)
      .where(and(eq(partner_members.partner_id, partner.id), eq(partner_members.user_id, input.userId)))
    const sync = await syncPartnerMemberships(tx, partner.id, now)
    return {
      rows: {},
      data: {
        removedMemberships: sync.removed,
        invitationsCanceled: sync.invitationsCanceled,
        subject: subject(target.email),
      },
    }
  },

  'partnerInvitation.view': async ({ tx, actor, now }, input: { token: string }) => {
    const account = await me(tx, actor)
    const inv = await invitationByToken(tx, input.token)
    if (!inv || !isOpen(inv, now)) throw refusePartner('invitation_invalid')
    const [partner] = await tx.select().from(partners).where(eq(partners.id, inv.partner_id))
    if (!partner || partner.status === 'suspended') throw refusePartner('invitation_invalid')
    const [already] = await tx
      .select({ id: partner_members.user_id })
      .from(partner_members)
      .where(and(eq(partner_members.partner_id, partner.id), eq(partner_members.user_id, account.id)))
    const view: PartnerInvitationView = {
      partnerName: partner.name,
      role: inv.role as PartnerRole,
      email: inv.email,
      state: already ? 'member' : account.email.toLowerCase() === inv.email ? 'open' : 'other_email',
    }
    return { rows: {}, data: view }
  },

  'partnerInvitation.accept': async ({ tx, actor, now }, input: { token: string }) => {
    const account = await me(tx, actor)
    const found = await invitationByToken(tx, input.token)
    if (!found) throw refusePartner('invitation_invalid')
    const partner = await lockedPartner(tx, found.partner_id)
    // Read again under the partner's lock: a withdrawal or another accept committed meanwhile wins.
    const inv = await invitationByToken(tx, input.token)
    if (!inv || !isOpen(inv, now)) throw refusePartner('invitation_invalid')
    if (partner.status === 'suspended') throw refusePartner('partner_suspended')
    if (account.email.toLowerCase() !== inv.email) throw refusePartner('invitation_other_email')
    if (!account.emailVerified) throw refusePartner('email_unverified')
    const [already] = await tx
      .select({ id: partner_members.user_id })
      .from(partner_members)
      .where(and(eq(partner_members.partner_id, partner.id), eq(partner_members.user_id, account.id)))
    if (already) throw refusePartner('already_member')
    if (await ownsClientByEmail(tx, partner.id, account.email)) throw refusePartner('client_owner')
    if (inv.role === 'owner') {
      const [owner] = await tx
        .select({ id: partner_members.user_id })
        .from(partner_members)
        .where(and(eq(partner_members.partner_id, partner.id), eq(partner_members.role, 'owner')))
      if (owner) throw refusePartner('owner_taken')
    }
    await tx
      .insert(partner_members)
      .values({ partner_id: partner.id, user_id: account.id, role: inv.role, created_at: now })
    await tx.update(partner_invitations).set({ accepted_at: now }).where(eq(partner_invitations.id, inv.id))
    await syncPartnerMemberships(tx, partner.id, now)
    return {
      rows: {},
      data: { partner: { id: partner.id, name: partner.name }, role: inv.role, subject: subject(account.email) },
    }
  },

  'workspace.createForClient': createForClient,

  'workspace.inviteClientOwner': async (ctx, input: { partnerId: string; workspaceId: string; email: string }) => {
    const { partner } = await partnerFor(ctx.tx, ctx.actor, input.partnerId, { write: true, owner: true })
    const org = await clientOf(ctx.tx, partner.id, input.workspaceId)
    await inviteOwner(ctx, partner.id, org, input.email)
    return { rows: {}, data: { workspace: org, subject: { email: input.email, workspaceId: org.id } } }
  },

  'partner.releaseClient': async (ctx, input: { partnerId: string; workspaceId: string; confirmName: string }) => {
    const { partner } = await partnerFor(ctx.tx, ctx.actor, input.partnerId, { write: true, owner: true })
    const org = await clientOf(ctx.tx, partner.id, input.workspaceId)
    refuseUnconfirmed(org.name, input.confirmName)
    const done = await detachClient(ctx, partner.id, org.id)
    return {
      rows: {},
      data: { partner: { id: partner.id, name: partner.name }, ...done, subject: { email: null, workspaceId: org.id } },
    }
  },

  /**
   * The client's owner removes its partner (permission workspace:own: the workspace's one owner, in their workspace).
   * Not while impersonated (not on the impersonation allow-list either) and with no key (workspace keys and setup
   * links never carry workspace:own, a personal key is refused in personal-key-scope.ts): it moves what the workspace
   * pays to the owner.
   */
  'workspace.removePartner': async (ctx, input: { confirmName: string }) => {
    const { tx, actor } = ctx
    if (actor.impersonation) throw new Forbidden(NOT_WHILE_IMPERSONATING)
    if (!actor.workspaceId) throw refusePartner('no_partner')
    const [seen] = await tx
      .select({ name: organization.name, partnerId: organization.partnerId })
      .from(organization)
      .where(eq(organization.id, actor.workspaceId))
    if (!seen?.partnerId) throw refusePartner('no_partner')
    refuseUnconfirmed(seen.name, input.confirmName)
    // The partner row first, as every partner change takes it (a team change or a suspension waits).
    const partner = await lockedPartner(tx, seen.partnerId)
    const done = await detachClient(ctx, partner.id, actor.workspaceId)
    return {
      rows: {},
      data: {
        partner: { id: partner.id, name: partner.name },
        ...done,
        subject: { email: null, workspaceId: done.workspace.id },
      },
    }
  },

  // --- Server admin › Partners --------------------------------------------------------------------------------

  'partner.adminList': async ({ tx, now }) => {
    const rows = await tx.select().from(partners).orderBy(asc(partners.name))
    const team = await tx
      .select({
        partnerId: partner_members.partner_id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: partner_members.role,
      })
      .from(partner_members)
      .innerJoin(user, eq(user.id, partner_members.user_id))
    const clients = await tx
      .select({ partnerId: organization.partnerId, count: sql<number>`count(*)::int` })
      .from(organization)
      .where(sql`${organization.partnerId} is not null`)
      .groupBy(organization.partnerId)
    const ownerInvites = await tx
      .select()
      .from(partner_invitations)
      .where(
        and(
          eq(partner_invitations.role, 'owner'),
          isNull(partner_invitations.accepted_at),
          isNull(partner_invitations.canceled_at),
          gt(partner_invitations.expires_at, now),
        ),
      )
    const list: AdminPartner[] = rows.map(p => {
      const owner = team.find(m => m.partnerId === p.id && m.role === 'owner')
      const invite = ownerInvites.find(i => i.partner_id === p.id)
      return {
        id: p.id,
        name: p.name,
        status: p.status as PartnerStatus,
        createdAt: p.created_at,
        approvedAt: p.approved_at,
        owner: owner ? { userId: owner.userId, name: owner.name, email: owner.email } : null,
        ownerInvitation: !owner && invite ? { email: invite.email, expiresAt: invite.expires_at } : null,
        members: team.filter(m => m.partnerId === p.id).length,
        clients: clients.find(c => c.partnerId === p.id)?.count ?? 0,
        billingAccountId: p.billing_account_id,
      }
    })
    return { rows: {}, data: { partners: list, clientLimit: await partnerClientLimit(tx) } }
  },

  /**
   * A partner made by hand (no bill: the partner sign-up with its bill is S2), pending until approved, and its owner
   * invited by email. Seam for S2: the sign-up makes the bill and the partner in one transaction and links them.
   */
  'partner.create': async ({ tx, actor, now }, input: { name: string; ownerEmail: string }) => {
    const id = newId('ptn')
    await tx
      .insert(partners)
      .values({ id, name: input.name, created_by: actor.actorId, created_at: now, updated_at: now })
    await invite(tx, { id, name: input.name }, input.ownerEmail, 'owner', actor.actorId, now)
    return { rows: {}, data: { partner: { id, name: input.name }, subject: subject(input.ownerEmail) } }
  },

  'partner.approve': async ({ tx, actor, now }, input: { partnerId: string }) => {
    const partner = await lockedPartner(tx, input.partnerId)
    await tx
      .update(partners)
      .set({
        status: 'approved',
        approved_at: partner.approved_at ?? now,
        approved_by: partner.approved_by ?? actor.actorId,
        suspended_at: null,
        updated_at: now,
      })
      .where(eq(partners.id, partner.id))
    // A suspended partner's team gets its client workspaces back.
    const sync = await syncPartnerMemberships(tx, partner.id, now)
    return {
      rows: {},
      data: { partner: { id: partner.id, name: partner.name }, addedMemberships: sync.added, subject: subject(null) },
    }
  },

  'partner.setClientLimit': async ({ tx, actor, now }, input: { limit: number }) => {
    const value = String(input.limit)
    await tx
      .insert(instance_settings)
      .values({ key: CLIENT_LIMIT_KEY, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    return { rows: {}, data: { clientLimit: input.limit, subject: subject(null) } }
  },

  'partner.suspend': async ({ tx, now }, input: { partnerId: string }) => {
    const partner = await lockedPartner(tx, input.partnerId)
    if (partner.status !== 'suspended')
      await tx
        .update(partners)
        .set({ status: 'suspended', suspended_at: now, updated_at: now })
        .where(eq(partners.id, partner.id))
    // Its team leaves every client workspace at once (API keys revoked, read sync refused).
    const sync = await syncPartnerMemberships(tx, partner.id, now)
    return {
      rows: {},
      data: {
        partner: { id: partner.id, name: partner.name },
        removedMemberships: sync.removed,
        invitationsCanceled: sync.invitationsCanceled,
        subject: subject(null),
      },
    }
  },
}
