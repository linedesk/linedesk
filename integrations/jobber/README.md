# Jobber app

The Jobber app that Linedesk workspaces connect to (Integrations › Jobber). When a business connects, Linedesk adds
every finished phone call as a note on the caller's Jobber client, and adds new callers as clients
(docs/crm-sync.md, "Jobber").

## Create the app

1. Sign up at [developer.getjobber.com](https://developer.getjobber.com/) (a developer account is free). Jobber
   offers a free tester account for live tests: Developer Center › Test accounts.
2. Apps › New app:
   - App name: `Linedesk`. Developer name, description and logo as in the listing.
   - OAuth Callback URL: `<origin>/v1/apps/callback/jobber`, for example
     `https://app.linedesk.ai/v1/apps/callback/jobber`. Server admin › Providers › Jobber shows the exact URL of the
     install. Use one Jobber app per origin (production, staging, each self-hosted install).
   - Scopes: **Clients**, read and write (`read_clients`, `write_clients`). Nothing else: Linedesk finds, adds and
     fills clients and adds notes to them.
   - Refresh token rotation: keep it on. Linedesk stores the new refresh token after every refresh.
   - Webhooks: one, topic **APP_DISCONNECT**, URL `<origin>/v1/apps/webhook/jobber`, for example
     `https://app.linedesk.ai/v1/apps/webhook/jobber`. Jobber requires it for a published app. When a business
     removes Linedesk in Jobber, Linedesk deletes every connection to that Jobber account and its tokens. Jobber signs
     each delivery with the client secret (`X-Jobber-Hmac-SHA256`); no other secret is needed. Other topics are
     ignored.
3. Save. Copy the **Client ID** and the **Client secret** from the app's page.
4. Paste them into Server admin › Providers › Jobber (never into this repo or `.env`; the secret is stored encrypted)
   and click Test. The test asks Jobber's token endpoint with a made-up refresh token: Jobber names a wrong client ID
   or secret, so a wrong pair fails the test.

## Limits

- A draft app (not published) can connect to at most 5 Jobber accounts; Jobber blocks API access above that. More need
  Jobber's app review and the App Marketplace listing (Developer Center › Manage Apps › Request review).
- Access tokens last 60 minutes. Disconnecting in Linedesk runs Jobber's `appDisconnect`, which removes Linedesk from
  the Jobber account (not while another Linedesk workspace uses the same Jobber account).
- Disconnecting in Jobber sends APP_DISCONNECT: Linedesk deletes the connection in every workspace that uses that
  Jobber account. A new client secret changes the webhook signature too: save it in Server admin at once.
- Every request names the GraphQL version (`JOBBER_GRAPHQL_VERSION` in `packages/connectors/src/jobber.ts`). Jobber
  versions by date; the support window is not confirmed in its public docs (check before review). Move it forward with the changelog at
  developer.getjobber.com/docs/changelog.
- A self-hosted install makes its own Jobber app the same way, with its own callback URL.
