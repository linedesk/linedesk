// What the web app needs to show onboarding: where the workspace is, and whether phone setup can work here.
import type { OnboardingStep } from '@linedesk/actions'
import { assistants, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { phoneSetupStatus, type PhoneSetupStatus } from './handlers.ts'
import { telephonyProvider } from './provider-settings.ts'

/**
 * What the web app may show about phone setup. `detail` names what the server lacks (environment
 * variables, missing keys): only instance admins get it, owners see plain copy instead.
 */
export type PhoneSetupView = { provider: string | null; available: boolean; detail: string | null }
export type OnboardingState = { step: Exclude<OnboardingStep, 'done'>; phone: PhoneSetupView }

export function phoneSetupView(status: PhoneSetupStatus, actor: Pick<Actor, 'permissions'>): PhoneSetupView {
  const isAdmin = actor.permissions.includes('instance:admin')
  return { provider: status.provider, available: !status.problem, detail: isAdmin ? status.problem : null }
}

/** Phone setup as this member may see it; null for members who cannot change settings. */
export async function phoneSetupFor(actor: Actor): Promise<PhoneSetupView | null> {
  if (!actor.workspaceId || !actor.permissions.includes('settings:write')) return null
  return phoneSetupView(await phoneSetupStatus(() => telephonyProvider(db)), actor)
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

/** The default assistant of a new workspace. */
export const newAssistant = (workspaceId: string, businessName: string) => ({
  id: `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
  workspace_id: workspaceId,
  greeting: `Thanks for calling ${businessName}. This is Maya, the AI assistant. How can I help?`,
})

/** The rows every workspace needs besides the organization: its assistant and its settings. Missing ones are added. */
export async function ensureWorkspaceRows(
  workspaceId: string,
  businessName: string,
  timeZone: unknown,
  onboardingStep?: OnboardingStep,
) {
  // A workspace has at least one assistant; one that has some keeps them.
  const [any] = await db.select({ id: assistants.id }).from(assistants).where(eq(assistants.workspace_id, workspaceId)).limit(1)
  if (!any) await db.insert(assistants).values(newAssistant(workspaceId, businessName))
  const settings = {
    ...newWorkspaceSettings(workspaceId, timeZone),
    ...(onboardingStep ? { onboarding_step: onboardingStep } : {}),
  }
  await db.insert(workspace_settings).values(settings).onConflictDoNothing({ target: workspace_settings.workspace_id })
  if (onboardingStep)
    await db
      .update(workspace_settings)
      .set({ onboarding_step: onboardingStep })
      .where(eq(workspace_settings.workspace_id, workspaceId))
}

/** null when onboarding is over, or when this member cannot change settings (only owners and admins set up). */
export async function onboardingFor(actor: Actor): Promise<OnboardingState | null> {
  if (!actor.workspaceId || !actor.permissions.includes('settings:write')) return null
  const [settings] = await db
    .select({ step: workspace_settings.onboarding_step })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, actor.workspaceId))
  const step = settings?.step
  if (!step || step === 'done' || step === 'skipped') return null
  return { step, phone: (await phoneSetupFor(actor))! }
}
