// What the web app needs to show onboarding: where the workspace is, and whether phone setup can work here.
import {
  BASE_BUY_OFFERS,
  type BuyOffer,
  type CallQuality,
  DEFAULT_AI_DISCLOSURE,
  greetingFor,
  type OnboardingStep,
  resumeStep,
  stepFor,
} from '@linedesk/actions'
import { assistants, organization, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { TransferContact } from '@linedesk/db/types'
import { businessLookupOn, type WebsiteImport, websiteImportFor } from './business-import.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { newAssistantTransfers } from './default-transfers.ts'
import { newAssistantLevel } from './call-quality.ts'
import { numberBuyOffers } from './number-buy.ts'
import { telephonyForWorkspace } from './workspace-carrier.ts'

// Here, not in handlers.ts: handlers.ts imports admin-handlers.ts, which reaches this file (LIN-493).
/** Whether `phoneNumber.setup` can work on this server: the carrier it would use, or why it cannot. */
export type PhoneSetupStatus = { provider: string | null; problem: string | null }

export async function phoneSetupStatus(
  loadProvider: () => Promise<{ name: string }>,
  env: Record<string, string | undefined> = process.env,
): Promise<PhoneSetupStatus> {
  try {
    const { name } = await loadProvider()
    if (name !== 'dev' && !env.LIVEKIT_SIP_ENDPOINT)
      return { provider: name, problem: 'LIVEKIT_SIP_ENDPOINT is not set' }
    return { provider: name, problem: null }
  } catch (e) {
    return { provider: null, problem: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * What the web app may show about phone setup. `detail` names what the server lacks (environment
 * variables, missing keys): only instance admins get it, owners see plain copy instead.
 */
export type PhoneSetupView = {
  provider: string | null
  available: boolean
  detail: string | null
  /**
   * Whether this member may attach a number that is already in the carrier account: always in the workspace's own
   * account and without a real carrier (dev); in the install's account (any carrier) only an instance admin, whatever
   * the workspace's bill. The same rule as phoneNumber.setup (attachRefused in handlers.ts).
   */
  canAttach: boolean
  /** Where a number can be bought on this workspace's carrier account (numberBuyOffers): one list for app, API and MCP. */
  buy: BuyOffer[]
  /** Whose carrier account numbers are set up on: the install's (billed numbers on a bill), or the workspace's own. */
  account: 'install' | 'workspace'
}
/**
 * `businessLookup`: the install can look businesses up (Google Places): the first step searches by name and city.
 * `websiteImport`: whether that step may offer to read the business's website (websiteImportFor).
 */
export type OnboardingState = {
  step: Exclude<OnboardingStep, 'done'>
  phone: PhoneSetupView
  businessLookup: boolean
  websiteImport: WebsiteImport
  /**
   * Waiting for its trial with its setup finished or set aside before (a workspace that left its partner): only the
   * card is left, so the onboarding opens at `activate` by hand, not on the owner's agent setup page. Absent otherwise.
   */
  onlyCard?: true
}

export function phoneSetupView(
  status: PhoneSetupStatus,
  actor: Pick<Actor, 'permissions'>,
  account: 'install' | 'workspace' = 'install',
  buy: BuyOffer[] = [...BASE_BUY_OFFERS],
): PhoneSetupView {
  const isAdmin = actor.permissions.includes('instance:admin')
  const canAttach = account === 'workspace' || status.provider === 'dev' || isAdmin
  return {
    provider: status.provider,
    available: !status.problem,
    detail: isAdmin ? status.problem : null,
    canAttach,
    buy,
    account,
  }
}

/** Phone setup as this member may see it; null for members who cannot change settings. */
export async function phoneSetupFor(actor: Actor): Promise<PhoneSetupView | null> {
  if (!actor.workspaceId || !actor.permissions.includes('settings:write')) return null
  const workspaceId = actor.workspaceId
  // The workspace's own carrier account when it has one, else the install's.
  let account: 'install' | 'workspace' = 'install'
  const status = await phoneSetupStatus(async () => {
    const resolved = await telephonyForWorkspace(db, workspaceId)
    account = resolved.account
    return resolved.provider
  })
  const buy = await numberBuyOffers(db, { account, provider: status.provider })
  return phoneSetupView(status, actor, account, buy)
}

const FALLBACK_TIME_ZONE = 'America/New_York'

/** The browser's time zone if it is a real IANA zone, else the US default. */
export function workspaceTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value) return FALLBACK_TIME_ZONE
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return FALLBACK_TIME_ZONE
  }
}

/** A new workspace starts onboarding; older workspaces have no step and never see it. */
export const newWorkspaceSettings = (workspaceId: string, timeZone: unknown) => ({
  workspace_id: workspaceId,
  timezone: workspaceTimeZone(timeZone),
  onboarding_step: 'business' as const,
})

/**
 * The default assistant of a new workspace; `transfers`: its first contact named in the workspace's language
 * (newAssistantTransfers); `callQuality`: the install's level for new assistants (newAssistantLevel). A new workspace's
 * first assistant takes it whatever it costs: the workspace's owner is the one who pays for it.
 */
export const newAssistant = (
  workspaceId: string,
  businessName: string,
  transfers: TransferContact[],
  callQuality: CallQuality,
) => ({
  id: `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
  workspace_id: workspaceId,
  greeting: greetingFor(businessName, 'Maya'),
  ai_disclosure: DEFAULT_AI_DISCLOSURE,
  transfers,
  call_quality: callQuality,
})

/** The rows every workspace needs besides the organization: its assistant and its settings. Missing ones are added. */
export async function ensureWorkspaceRows(
  workspaceId: string,
  businessName: string,
  timeZone: unknown,
  onboardingStep?: OnboardingStep,
) {
  // A workspace has at least one assistant; one that has some keeps them.
  const [any] = await db
    .select({ id: assistants.id })
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .limit(1)
  const settings = {
    ...newWorkspaceSettings(workspaceId, timeZone),
    ...(onboardingStep ? { onboarding_step: onboardingStep } : {}),
  }
  // The settings first: the assistant's first contact is named in the workspace's language, which they decide.
  await db.insert(workspace_settings).values(settings).onConflictDoNothing({ target: workspace_settings.workspace_id })
  if (!any)
    await db
      .insert(assistants)
      .values(
        newAssistant(
          workspaceId,
          businessName,
          await newAssistantTransfers(db, workspaceId),
          await newAssistantLevel(db),
        ),
      )
  if (onboardingStep)
    await db
      .update(workspace_settings)
      .set({ onboarding_step: onboardingStep })
      .where(eq(workspace_settings.workspace_id, workspaceId))
}

/** What "Find your business" may offer this member: looking the business up, and reading its website. */
export type BusinessSetup = Pick<OnboardingState, 'businessLookup' | 'websiteImport'>

/**
 * What "Find your business" may offer when the setup steps are gone through again from the settings ("Step by step",
 * apps/web/src/onboarding/StepByStep.tsx); null for members who cannot change settings, and while onboarding is open
 * (its state says the same).
 */
export async function businessSetupFor(
  actor: Actor,
  onboarding: OnboardingState | null,
): Promise<BusinessSetup | null> {
  if (onboarding || !actor.workspaceId || !actor.permissions.includes('settings:write')) return null
  return { businessLookup: await businessLookupOn(), websiteImport: await websiteImportFor(actor.workspaceId) }
}

/** null when onboarding is over, or when this member cannot change settings (only owners and admins set up). */
export async function onboardingFor(actor: Actor): Promise<OnboardingState | null> {
  if (!actor.workspaceId || !actor.permissions.includes('settings:write')) return null
  const [settings] = await db
    .select({
      step: workspace_settings.onboarding_step,
      billingState: organization.billingState,
      partnerId: organization.partnerId,
    })
    .from(organization)
    .leftJoin(workspace_settings, eq(workspace_settings.workspace_id, organization.id))
    .where(eq(organization.id, actor.workspaceId))
  // A sign-up whose trial has not started always has its last step ahead: the card. Nothing
  // else of the app opens before it, also when its setup was finished or set aside (a workspace that left its partner).
  // A partner's draft client workspace waits for the partner's Checkout instead (White-label Cloud): no card step of its
  // own; its number is refused until then (self-serve.ts).
  const activating = settings?.billingState === 'pending_payment' && !settings.partnerId
  const stored = settings?.step
  const step = activating && (!stored || stored === 'done' || stored === 'skipped') ? 'activate' : stored
  if (!step || step === 'done' || step === 'skipped') return null
  // A step of the earlier flow resumes at the step that took its place; `activate` only while the trial waits.
  const resumed = stepFor(resumeStep(step), activating)
  if (resumed === 'done') return null
  return {
    step: resumed,
    ...(activating && step === 'activate' && stored !== 'activate' ? { onlyCard: true as const } : {}),
    phone: (await phoneSetupFor(actor))!,
    businessLookup: await businessLookupOn(),
    websiteImport: await websiteImportFor(actor.workspaceId),
  }
}
