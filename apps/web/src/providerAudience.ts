import type { ProviderAudience } from '@linedesk/actions'
import { i18n } from './i18n/index.tsx'

// Who reads a problem with this install's providers in this tab (LIN-111): instance admins fix it under
// Server admin › Providers, everyone else asks whoever runs the server. Set from /me in App (before Onboarding) and
// Workspace, so error texts that are built without `me` (refusals, toasts, test call, listening in) still name the
// right next step.
let current: ProviderAudience = 'member'

export const providerAudience = (): ProviderAudience => current
export const setProviderAudience = (audience: ProviderAudience) => {
  current = audience
}

/** The next step after "… isn't set up on this server yet." `what` is what an admin adds there. */
export const whoSetsUp = (what: 'voice' | 'calendar', audience: ProviderAudience = current): string =>
  audience === 'admin'
    ? what === 'voice'
      ? i18n().t('common.provider.addVoice')
      : i18n().t('common.provider.addCalendar')
    : i18n().t('common.provider.askOwner')
