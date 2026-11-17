import { createHubSpotConnector, createHubSpotOAuth } from './hubspot.ts'
import { createJobberConnector, createJobberOAuth } from './jobber.ts'
import { createSlackConnector, createSlackOAuth } from './slack.ts'
import type { AppConnector, AppId, AppOAuth, OAuthClient } from './types.ts'

/**
 * Every connected app, by id. A new app: add its id to APP_IDS, write `<app>.ts` with its OAuth and
 * connector (a CRM implements CrmProvider and reuses pushCallToCrm; an app that only posts, like Slack, implements
 * pushCall itself), and add it here.
 */
const APPS: Record<AppId, { oauth: (client: OAuthClient) => AppOAuth; connector: () => AppConnector }> = {
  hubspot: { oauth: client => createHubSpotOAuth(client), connector: () => createHubSpotConnector() },
  slack: { oauth: client => createSlackOAuth(client), connector: () => createSlackConnector() },
  jobber: { oauth: client => createJobberOAuth(client), connector: () => createJobberConnector() },
}

export const appOAuth = (id: AppId, client: OAuthClient): AppOAuth => APPS[id].oauth(client)
export const appConnector = (id: AppId): AppConnector => APPS[id].connector()
