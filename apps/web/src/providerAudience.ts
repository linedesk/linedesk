import type { ProviderAudience } from '@linedesk/actions'

// Who reads a problem with this install's providers in this tab (LIN-111): instance admins fix it under
// Server admin › Providers, everyone else asks whoever runs the server. Set from /me in Workspace, so error texts that
// are built without `me` (refusals, toasts, test call, listening in) still name the right next step.
let current: ProviderAudience = 'member'

export const providerAudience = (): ProviderAudience => current
export const setProviderAudience = (audience: ProviderAudience) => {
  current = audience
}

/** The next step after "… isn't set up on this server yet." `what` is what an admin adds there. */
export const whoSetsUp = (what: string, audience: ProviderAudience = current): string =>
  audience === 'admin' ? `Add ${what} under Server admin › Providers.` : 'Ask whoever runs it.'
