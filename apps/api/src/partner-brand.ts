// A white-label partner's brand (docs/white-label.md, slice S4; actions in packages/actions/src/partner-brand.ts).
//
// Two versions (security review of #1111, M-2): the partner's draft, and the version an instance admin approved. A
// change of name, logo, support email or links is a new revision that waits for review; every such change is emailed to
// the instance admins. The color is not reviewed.
//
// Where it shows:
// - In the app: GET /v1/branding answers with the brand of the signed-in session's active workspace when that is a
//   client workspace of a partner that is not suspended: its team sees the draft, everyone else the approved version
//   (none approved: the install's). The web app asks again when it switches workspace. Before sign-in the install's: the
//   brand of the request's host needs partner domains (S5), which plug in at brandingForActor.
// - In emails: withWorkspaceBrand runs a workspace's emails with its partner's approved brand (name, logo, color,
//   Reply-To the support email, no "Powered by"), once the partner may use it in emails: approved by an instance admin,
//   and its bill runs and has a paid subscription invoice (where the install has billing). Until then the install's.
// - Links in those emails: appOrigin(workspaceId), the install's WEB_ORIGIN until a partner's own domain is live (S5).
//
// Names on the install's protected list (instance setting, Server admin › Partners) are refused. Every change lands in
// the command log ("Partners"); instance admins approve a revision or reset the brand (partnerBrand.approve, .reset).
import { createHash } from 'node:crypto'
import {
  type Branding,
  DEFAULT_PROTECTED_NAMES,
  type PartnerBrand,
  type PartnerBrandData,
  type PartnerBrandInput,
  type PartnerBrandReview,
  type PartnerBrandReviewState,
  type ProtectedNamesData,
  protectedNameIn,
} from '@linedesk/actions'
import {
  billing_accounts,
  billing_invoices,
  instance_settings,
  organization,
  partner_branding,
  partner_members,
  partners,
  type Tx,
  user,
} from '@linedesk/db'
import { and, desc, eq, gt } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { billingSwitchOn } from './billing-settings.ts'
import { decodeLogo } from './branding.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type EmailBrand, withEmailBrand } from './email-brand.ts'
import { partnerBrandChangedAlert } from './emails/alerts.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { NOT_ON_PARTNER_TEAM, PARTNER_OWNER_ONLY, PARTNER_SUSPENDED } from './partner-refusals.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const PROTECTED_NAMES_KEY = 'partner.protectedNames'

type PartnerRow = typeof partners.$inferSelect
type BrandRow = typeof partner_branding.$inferSelect

/**
 * The address of the app for one workspace: every link in its emails, invitations and pushes. The install's
 * WEB_ORIGIN for now; with partner domains (S5) a client workspace's partner domain once it is live.
 */
export async function appOrigin(_workspaceId: string, _tx: Tx | typeof db = db): Promise<string> {
  return WEB_ORIGIN
}

export const partnerLogoPath = (partnerId: string, version: string) =>
  `/v1/branding/partners/${encodeURIComponent(partnerId)}/logo.png?v=${encodeURIComponent(version)}`

const logoUrlOf = (partnerId: string, logo: string | null, version: string | null) =>
  logo && version ? partnerLogoPath(partnerId, version) : null

/** The partner's draft: what its team sees and edits. */
const draftOf = (row: BrandRow): PartnerBrand => ({
  name: row.name,
  color: row.color,
  logoUrl: logoUrlOf(row.partner_id, row.logo, row.logo_version),
  supportEmail: row.support_email,
  termsUrl: row.terms_url,
  privacyUrl: row.privacy_url,
})

/** The version an instance admin approved: what clients and emails get. Null while none is. The color is the draft's. */
const approvedOf = (row: BrandRow): PartnerBrand | null =>
  row.approved_revision === null || row.approved_name === null
    ? null
    : {
        name: row.approved_name,
        color: row.color,
        logoUrl: logoUrlOf(row.partner_id, row.approved_logo, row.approved_logo_version),
        supportEmail: row.approved_support_email,
        termsUrl: row.approved_terms_url,
        privacyUrl: row.approved_privacy_url,
      }

/** From the content, never from revision numbers: a draft equal to the approved version waits for nothing. */
const reviewStateOf = (row: BrandRow): PartnerBrandReviewState =>
  row.approved_revision === null ? 'none' : sameReviewed(row, approvedReviewed(row)) ? 'approved' : 'pending'

/** A brand as GET /v1/branding returns it: no star prompt and no "Powered by" for a partner's clients. */
export function brandingOf(partnerId: string, brand: PartnerBrand): Branding {
  return {
    name: brand.name,
    color: brand.color,
    logoUrl: brand.logoUrl,
    starPrompt: false,
    starCount: null,
    poweredBy: false,
    partner: { id: partnerId, supportEmail: brand.supportEmail, terms: brand.termsUrl, privacy: brand.privacyUrl },
  }
}

/** The workspace's partner and its brand row, or null for a workspace without a partner. */
async function partnerOfWorkspace(
  tx: Tx | typeof db,
  workspaceId: string,
): Promise<{ partner: PartnerRow; brand: BrandRow | null } | null> {
  const [row] = await tx
    .select({ partner: partners, brand: partner_branding })
    .from(organization)
    .innerJoin(partners, eq(partners.id, organization.partnerId))
    .leftJoin(partner_branding, eq(partner_branding.partner_id, partners.id))
    .where(eq(organization.id, workspaceId))
  return row ?? null
}

/** Whether the workspace belongs to a partner (no Linedesk star prompt there, star-prompt.ts). */
export async function hasPartner(workspaceId: string, tx: Tx | typeof db = db): Promise<boolean> {
  const [row] = await tx
    .select({ partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  return !!row?.partnerId
}

async function onTeam(tx: Tx | typeof db, partnerId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ role: partner_members.role })
    .from(partner_members)
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.user_id, userId)))
  return !!row
}

/**
 * The brand a person sees in the app in this workspace, or null (the install's): none while the partner is suspended;
 * the draft for someone on the partner's team (to see their change before it is approved); the approved version for
 * everyone else, the client's own people.
 */
export async function appBrandOf(
  workspaceId: string,
  userId: string | null,
  tx: Tx | typeof db = db,
): Promise<Branding | null> {
  const found = await partnerOfWorkspace(tx, workspaceId)
  if (!found?.brand || found.partner.status === 'suspended') return null
  const brand = userId && (await onTeam(tx, found.partner.id, userId)) ? draftOf(found.brand) : approvedOf(found.brand)
  return brand ? brandingOf(found.partner.id, brand) : null
}

/** Bill statuses under which a partner's brand may go into emails: the plan runs (comped: an admin gave it). */
const BRAND_BILL_STATUSES = new Set(['active', 'past_due', 'comped'])

/**
 * Whether the partner may use its brand in emails (design §11, phishing with a borrowed brand): approved by an
 * instance admin, and its bill runs (`active`, `past_due`, `comped`) and, unless comped, has a paid subscription invoice
 * with an amount: a minutes top-up in the trial does not count (security review of #1111, L-2). A partner without a
 * bill passes the second only where the install has no billing (self-host, dev); on a billed install it has no client
 * workspaces anyway.
 */
export async function brandGate(
  tx: Tx | typeof db,
  partner: PartnerRow,
): Promise<{ approved: boolean; paid: boolean }> {
  const approved = partner.status === 'approved'
  if (!partner.billing_account_id) return { approved, paid: !(await billingSwitchOn(tx as Tx)) }
  const [bill] = await tx
    .select({ status: billing_accounts.status })
    .from(billing_accounts)
    .where(eq(billing_accounts.id, partner.billing_account_id))
  if (!bill || !BRAND_BILL_STATUSES.has(bill.status)) return { approved, paid: false }
  if (bill.status === 'comped') return { approved, paid: true }
  const [invoice] = await tx
    .select({ id: billing_invoices.stripe_invoice_id })
    .from(billing_invoices)
    .where(
      and(
        eq(billing_invoices.billing_account_id, partner.billing_account_id),
        eq(billing_invoices.kind, 'subscription'),
        eq(billing_invoices.status, 'paid'),
        gt(billing_invoices.total_cents, 0),
      ),
    )
    .limit(1)
  return { approved, paid: !!invoice }
}

/**
 * The brand of the workspace's emails: its partner's approved version once the gate is passed, else null (the
 * install's). A change waiting for review never reaches an email.
 */
export async function emailBrandOf(workspaceId: string, tx: Tx | typeof db = db): Promise<EmailBrand | null> {
  const found = await partnerOfWorkspace(tx, workspaceId)
  const approved = found?.brand ? approvedOf(found.brand) : null
  if (!found || !approved) return null
  const gate = await brandGate(tx, found.partner)
  if (!gate.approved || !gate.paid) return null
  return {
    branding: brandingOf(found.partner.id, approved),
    replyTo: approved.supportEmail,
    origin: await appOrigin(workspaceId, tx),
  }
}

/**
 * Runs `work` (rendering and sending a workspace's emails) with the workspace's email brand. A failure to read the
 * brand is logged and the email goes out with the install's: an email is never lost over its look. `toCallers`: the
 * emails go to the business's callers (a booking confirmation), so replies are not sent to the partner's support.
 */
export async function withWorkspaceBrand<T>(
  workspaceId: string | null | undefined,
  work: () => Promise<T>,
  tx: Tx | typeof db = db,
  { toCallers = false }: { toCallers?: boolean } = {},
): Promise<T> {
  if (!workspaceId) return work()
  const brand = await emailBrandOf(workspaceId, tx).catch(err => {
    console.error(`could not read the email brand of ${workspaceId}; sending with the install's`, err)
    return null
  })
  return withEmailBrand(brand && toCallers ? { ...brand, replyTo: null } : brand, work)
}

/**
 * GET /v1/branding: the brand of the caller's active workspace when it is a partner's client, else null (the
 * install's). With partner domains (S5) the request's host comes first here.
 */
export async function brandingForActor(actor: Pick<Actor, 'workspaceId' | 'actorId'> | null): Promise<Branding | null> {
  if (!actor?.workspaceId) return null
  return appBrandOf(actor.workspaceId, actor.actorId)
}

/**
 * A partner's logo for /v1/branding/partners/<id>/logo.png?v=<version>, or null (404): only for a version the brand has.
 * The approved one is public and cached for good (emails show it, the sign-in page will in S5). A draft that is not
 * approved goes only to the partner's team and the instance admins, who review it, and is never cached: the install's
 * address would otherwise host any image a partner uploads (security review of #1111, N-2). `viewer` resolves the
 * signed-in account only when a draft is asked for.
 */
export async function partnerLogoFor(
  partnerId: string,
  version: string | undefined,
  viewer: () => Promise<string | null>,
): Promise<{ logo: Buffer; approved: boolean } | null> {
  if (!version) return null
  const [row] = await db
    .select({
      logo: partner_branding.logo,
      version: partner_branding.logo_version,
      approved: partner_branding.approved_logo,
      approvedVersion: partner_branding.approved_logo_version,
    })
    .from(partner_branding)
    .where(eq(partner_branding.partner_id, partnerId))
  if (row?.approved && row.approvedVersion === version)
    return { logo: Buffer.from(row.approved, 'base64'), approved: true }
  if (!row?.logo || row.version !== version) return null
  const userId = await viewer().catch(() => null)
  if (!userId || !(await mayReviewDraft(partnerId, userId))) return null
  return { logo: Buffer.from(row.logo, 'base64'), approved: false }
}

/** Someone on the partner's team, or an instance admin. */
async function mayReviewDraft(partnerId: string, userId: string): Promise<boolean> {
  if (await onTeam(db, partnerId, userId)) return true
  const [account] = await db.select().from(user).where(eq(user.id, userId))
  return !!account && isInstanceAdmin(account)
}

/** The install's protected names: an instance admin's list, else the built-in one. */
export async function protectedNames(tx: Tx | typeof db): Promise<ProtectedNamesData> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, PROTECTED_NAMES_KEY))
  if (row) {
    try {
      const names = JSON.parse(row.value) as unknown
      if (Array.isArray(names) && names.every(n => typeof n === 'string')) return { names, builtIn: false }
    } catch {
      // Unreadable: the built-in list below, so a broken setting never lets every name through.
    }
    console.error('the stored protected names cannot be read; using the built-in list')
  }
  return { names: [...DEFAULT_PROTECTED_NAMES], builtIn: true }
}

/** The partner for a caller on its team (403 otherwise, the same whether or not it exists), as partners.ts checks. */
async function partnerOnTeam(tx: Tx, actor: Actor, partnerId: string, write: boolean) {
  if (write) await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update')
  const [row] = await tx
    .select({ partner: partners, role: partner_members.role })
    .from(partner_members)
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.user_id, actor.actorId)))
  if (!row) throw new Forbidden(NOT_ON_PARTNER_TEAM)
  if (write && row.role !== 'owner') throw new Forbidden(PARTNER_OWNER_ONLY)
  if (write && row.partner.status === 'suspended') throw new Forbidden(PARTNER_SUSPENDED)
  return row
}

const brandRow = async (tx: Tx, partnerId: string, lock = false) => {
  const query = tx.select().from(partner_branding).where(eq(partner_branding.partner_id, partnerId))
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}

async function brandData(tx: Tx, partner: PartnerRow, role: string): Promise<PartnerBrandData> {
  const row = await brandRow(tx, partner.id)
  const gate = await brandGate(tx, partner)
  const approved = row ? approvedOf(row) : null
  return {
    brand: row ? draftOf(row) : null,
    review: { state: row ? reviewStateOf(row) : 'none', approved, approvedAt: row?.approved_at ?? null },
    emails: { ...gate, active: !!approved && gate.approved && gate.paid },
    canEdit: role === 'owner' && partner.status !== 'suspended',
  }
}

/** The fields an instance admin reviews: a change of any of them is a new revision. */
type Reviewed = Pick<BrandRow, 'name' | 'logo' | 'support_email' | 'terms_url' | 'privacy_url'>
function sameReviewed(a: Reviewed, b: Reviewed) {
  return (
    a.name === b.name &&
    a.logo === b.logo &&
    a.support_email === b.support_email &&
    a.terms_url === b.terms_url &&
    a.privacy_url === b.privacy_url
  )
}
function approvedReviewed(row: BrandRow): Reviewed {
  return {
    name: row.approved_name ?? '',
    logo: row.approved_logo,
    support_email: row.approved_support_email,
    terms_url: row.approved_terms_url,
    privacy_url: row.approved_privacy_url,
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * The reviewed content of the draft as one hash (name, the logo's bytes, support email, links): approve must name the
 * hash of the version the admin saw, so a draft that changed and changed back since never passes for it (security
 * review of #1111, N-1).
 */
export const contentHashOf = (row: Reviewed) =>
  sha256(
    JSON.stringify([row.name, row.logo ? sha256(row.logo) : null, row.support_email, row.terms_url, row.privacy_url]),
  )

async function reviewOf(tx: Tx, partnerId: string): Promise<PartnerBrandReview | null> {
  const [found] = await tx
    .select({ brand: partner_branding, partner: partners })
    .from(partner_branding)
    .innerJoin(partners, eq(partners.id, partner_branding.partner_id))
    .where(eq(partner_branding.partner_id, partnerId))
  return found ? toReview(found.brand, found.partner) : null
}

const toReview = (row: BrandRow, partner: PartnerRow): PartnerBrandReview => ({
  partnerId: partner.id,
  partner: partner.name,
  partnerStatus: partner.status,
  state: reviewStateOf(row),
  revision: row.revision,
  contentHash: contentHashOf(row),
  draft: draftOf(row),
  approved: approvedOf(row),
  updatedAt: row.updated_at,
  approvedAt: row.approved_at,
})

// i18n-ignore: API error body for logs and API clients; the admin page shows admin.partners.brands.error.no_brand
const NO_BRAND = 'this partner has no brand'
// i18n-ignore: API error body for logs and API clients; the admin page shows admin.partners.brands.error.brand_changed
const BRAND_CHANGED = 'the partner changed its brand since you looked; review the new version'

const subject = { email: null, workspaceId: null }

export const partnerBrandHandlers: Record<string, Handler> = {
  'partnerBrand.get': async ({ tx, actor }, input: { partnerId: string }) => {
    const { partner, role } = await partnerOnTeam(tx, actor, input.partnerId, false)
    return { rows: {}, data: await brandData(tx, partner, role) }
  },

  'partnerBrand.set': async ({ tx, actor, now, onCommit }, input: PartnerBrandInput) => {
    const { partner, role } = await partnerOnTeam(tx, actor, input.partnerId, true)
    const hit = protectedNameIn(input.name, (await protectedNames(tx)).names)
    // i18n-ignore: API error body for logs and API clients; the web app shows team.partner.brand.error.name_protected
    if (hit)
      throw new Reject(
        `"${input.name}" is or contains a protected name (${hit}); choose another name`,
        'name_protected',
      )
    const previous = await brandRow(tx, partner.id, true)
    const logo =
      input.logo === undefined
        ? { logo: previous?.logo ?? null, logo_version: previous?.logo_version ?? null }
        : input.logo === null
          ? { logo: null, logo_version: null }
          : { logo: decodeLogo(input.logo).toString('base64'), logo_version: crypto.randomUUID().slice(0, 8) }
    const reviewed: Reviewed = {
      name: input.name,
      logo: logo.logo,
      support_email: input.supportEmail,
      terms_url: input.termsUrl,
      privacy_url: input.privacyUrl,
    }
    // Back to the approved version: nothing to review, and its logo keeps its address.
    const backToApproved =
      !!previous && previous.approved_revision !== null && sameReviewed(reviewed, approvedReviewed(previous))
    const changed = !previous || !sameReviewed(reviewed, previous)
    // Only ever up, also back to the approved content: a number an admin saw is never reused (N-1).
    const revision = !previous ? 1 : changed ? previous.revision + 1 : previous.revision
    const values = {
      ...reviewed,
      logo_version:
        backToApproved && previous?.approved_logo === logo.logo ? previous.approved_logo_version : logo.logo_version,
      color: input.color,
      revision,
      updated_at: now,
      updated_by: actor.actorId,
    }
    await tx
      .insert(partner_branding)
      .values({ partner_id: partner.id, ...values })
      .onConflictDoUpdate({ target: partner_branding.partner_id, set: values })
    // Every change that waits for review is emailed to the instance admins, with what they need to judge it.
    if (changed && !backToApproved) {
      const alert = partnerBrandChangedAlert({
        partner: partner.name,
        name: input.name,
        approvedName: previous?.approved_name ?? null,
        logoUrl:
          values.logo && values.logo_version
            ? `${WEB_ORIGIN}${partnerLogoPath(partner.id, values.logo_version)}`
            : null,
        supportEmail: input.supportEmail,
        termsUrl: input.termsUrl,
        privacyUrl: input.privacyUrl,
        color: input.color,
        reviewUrl: `${WEB_ORIGIN}/#admin/partners`,
      })
      onCommit?.(async () => alertInstanceAdmins(alert))
    }
    return { rows: {}, data: { ...(await brandData(tx, partner, role)), subject } }
  },

  'partnerBrand.protectedNames': async ({ tx }) => ({ rows: {}, data: await protectedNames(tx) }),

  'partnerBrand.setProtectedNames': async ({ tx, actor, now }, input: { names: string[] | null }) => {
    if (input.names === null) {
      await tx.delete(instance_settings).where(eq(instance_settings.key, PROTECTED_NAMES_KEY))
    } else {
      const names = [...new Set(input.names.map(n => n.trim()).filter(Boolean))]
      const value = JSON.stringify(names)
      await tx
        .insert(instance_settings)
        .values({ key: PROTECTED_NAMES_KEY, value, updated_at: now, updated_by: actor.actorId })
        .onConflictDoUpdate({
          target: instance_settings.key,
          set: { value, updated_at: now, updated_by: actor.actorId },
        })
    }
    return { rows: {}, data: { ...(await protectedNames(tx)), subject } }
  },

  'partnerBrand.reviews': async ({ tx }) => {
    const rows = await tx
      .select({ brand: partner_branding, partner: partners })
      .from(partner_branding)
      .innerJoin(partners, eq(partners.id, partner_branding.partner_id))
      .orderBy(desc(partner_branding.updated_at))
    const brands = rows.map(r => toReview(r.brand, r.partner))
    // Waiting for review first, then the newest change.
    brands.sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending'))
    return { rows: {}, data: { brands } }
  },

  'partnerBrand.approve': async (
    { tx, actor, now },
    input: { partnerId: string; revision: number; contentHash: string; reason: string },
  ) => {
    const row = await brandRow(tx, input.partnerId, true)
    if (!row) throw new Reject(NO_BRAND, 'no_brand')
    // The version the admin saw, by number and by content, checked under the row's lock.
    if (row.revision !== input.revision || contentHashOf(row) !== input.contentHash)
      throw new Reject(BRAND_CHANGED, 'brand_changed')
    // The protected list may have grown since the partner saved the name.
    const hit = protectedNameIn(row.name, (await protectedNames(tx)).names)
    // i18n-ignore: API error body for logs and API clients; the admin page shows admin.partners.brands.error.name_protected
    if (hit) throw new Reject(`"${row.name}" is or contains a protected name (${hit})`, 'name_protected')
    await tx
      .update(partner_branding)
      .set({
        approved_revision: row.revision,
        approved_name: row.name,
        approved_logo: row.logo,
        approved_logo_version: row.logo_version,
        approved_support_email: row.support_email,
        approved_terms_url: row.terms_url,
        approved_privacy_url: row.privacy_url,
        approved_at: now,
        approved_by: actor.actorId,
      })
      .where(eq(partner_branding.partner_id, input.partnerId))
    return { rows: {}, data: { review: await reviewOf(tx, input.partnerId), subject } }
  },

  'partnerBrand.reset': async ({ tx }, input: { partnerId: string; reason: string }) => {
    const deleted = await tx
      .delete(partner_branding)
      .where(eq(partner_branding.partner_id, input.partnerId))
      .returning({ id: partner_branding.partner_id })
    if (!deleted.length) throw new Reject(NO_BRAND, 'no_brand')
    return { rows: {}, data: { subject } }
  },
}
