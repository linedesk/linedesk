import { createHubSpotConnector, createHubSpotOAuth } from './hubspot.ts'
import type { AppConnector, AppId, AppOAuth, OAuthClient } from './types.ts'

/**
 * Every connected app, by id. A new app: add its id to APP_IDS, write `<app>.ts` with its OAuth and
 * connector (a CRM implements CrmProvider and reuses pushCallToCrm), and add it here.
 */
const APPS: Record<AppId, { oauth: (client: OAuthClient) => AppOAuth; connector: () => AppConnector }> = {
  hubspot: { oauth: client => createHubSpotOAuth(client), connector: () => createHubSpotConnector() },
}

export const appOAuth = (id: AppId, client: OAuthClient): AppOAuth => APPS[id].oauth(client)
export const appConnector = (id: AppId): AppConnector => APPS[id].connector()
