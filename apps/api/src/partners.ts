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
  type PartnerData,
  type PartnerInvitationView,
  type PartnerRole,
  type PartnerStatus,
} from '@linedesk/actions'
import {
  instance_settings,
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
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { billingSwitchOn } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { localeForUserId } from './email-locale.ts'
import { emailSafeName, partnerInvitationEmail } from './emails/templates.ts'
import { Forbidden, type Handler, type HandlerCtx } from './handler-context.ts'
import { forgetMember } from './memberships.ts'
import { NOT_ON_PARTNER_TEAM, PARTNER_OWNER_ONLY, PARTNER_SUSPENDED, refusePartner } from './partner-refusals.ts'
import { createRateLimiter } from './rate-limit.ts'
import { cancelSentInvitations } from './team.ts'
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

async function partnerData(tx: Tx, partner: PartnerRow, role: PartnerRole, now: string): Promise<PartnerData> {
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
    clients: clients.map(c => ({ id: c.id, name: c.name, createdAt: c.createdAt.toISOString() })),
  }
}

/** Partner actions file their audit entry under no workspace, with whom the change was about. */
const subject = (email: string | null) => ({ email, workspaceId: null })

type CreateForClientInput = { partnerId: string; name: string; country?: string; timeZone?: string }

async function createForClient(ctx: HandlerCtx, input: CreateForClientInput) {
  const { tx, actor, now } = ctx
  const { partner } = await partnerFor(tx, actor, input.partnerId, { write: true })
  // Seam for S2 (LIN-453): where billing is on, a client workspace goes on the partner bill and adds a seat to its
  // subscription. Until then it is refused there, so no client workspace runs unbilled on a billed install.
  if (partner.billing_account_id || (await billingSwitchOn(tx))) throw refusePartner('client_needs_bill')
  // Client workspaces only once a server admin approved the partner, and at most the install's ceiling of them
  // (security review of #1100, L-2).
  if (partner.status === 'pending') throw refusePartner('partner_pending')
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.partnerId, partner.id))
  if (count >= (await partnerClientLimit(tx))) throw refusePartner('client_limit')
  const org = await insertWorkspace(
    ctx,
    {
      name: input.name,
      ...(input.country ? { country: input.country } : {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    },
    true,
  )
  await tx.update(organization).set({ partnerId: partner.id }).where(eq(organization.id, org.id))
  await syncPartnerMemberships(tx, partner.id, now)
  return {
    rows: {},
    // The audit log files the entry under the new workspace.
    data: { workspace: { id: org.id, name: org.name }, subject: { email: null, workspaceId: org.id } },
  }
}

export const partnerHandlers: Record<string, Handler> = {
  'partner.get': async ({ tx, actor, now }, input: { partnerId: string }) => {
    const { partner, role } = await partnerFor(tx, actor, input.partnerId)
    return { rows: {}, data: await partnerData(tx, partner, role, now) }
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
