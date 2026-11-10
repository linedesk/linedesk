// What the web app needs to show onboarding: where the workspace is, and whether phone setup can work here.
import type { OnboardingStep } from '@callfront/actions'
import { workspace_settings } from '@callfront/db'
import { eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { phoneSetupStatus, type PhoneSetupStatus } from './handlers.ts'
import { telephonyProvider } from './provider-settings.ts'

export type OnboardingState = { step: Exclude<OnboardingStep, 'done'>; phone: PhoneSetupStatus }

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
export const newWorkspaceSettings = (workspaceId: string, timeZone: unknown) =>
  ({ workspace_id: workspaceId, timezone: workspaceTimeZone(timeZone), onboarding_step: 'business' as const })

/** null when onboarding is over, or when this member cannot change settings (only owners and admins set up). */
export async function onboardingFor(actor: Actor): Promise<OnboardingState | null> {
  if (!actor.workspaceId || !actor.permissions.includes('settings:write')) return null
  const [settings] = await db.select({ step: workspace_settings.onboarding_step }).from(workspace_settings).where(eq(workspace_settings.workspace_id, actor.workspaceId))
  const step = settings?.step
  if (!step || step === 'done' || step === 'skipped') return null
  return { step, phone: await phoneSetupStatus(() => telephonyProvider(db)) }
}
