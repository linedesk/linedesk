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
     install. One app per origin, or one URL per app: Jobber allows one callback URL.
   - Scopes: **Clients**, read and write (`read_clients`, `write_clients`). Nothing else: Linedesk finds, adds and
     fills clients and adds notes to them.
   - Refresh token rotation: keep it on. Linedesk stores the new refresh token after every refresh.
   - Webhooks: none.
3. Save. Copy the **Client ID** and the **Client secret** from the app's page.
4. Paste them into Server admin › Providers › Jobber (never into this repo or `.env`; the secret is stored encrypted)
   and click Test. The test asks Jobber's token endpoint with a made-up refresh token: Jobber names a wrong client ID
   or secret, so a wrong pair fails the test.

## Limits

- A draft app (not published) works for at most 5 paying Jobber accounts plus tester accounts. More need Jobber's
  app review and the App Marketplace listing (Developer Center › the app › Submit for review).
- Access tokens last 60 minutes. Disconnecting in Linedesk runs Jobber's `appDisconnect`, which removes Linedesk from
  the Jobber account (not while another Linedesk workspace uses the same Jobber account).
- Every request names the GraphQL version (`JOBBER_GRAPHQL_VERSION` in `packages/connectors/src/jobber.ts`). Jobber
  supports a version for at least 12 months; move it forward with the changelog at
  developer.getjobber.com/docs/changelog.
- A self-hosted install makes its own Jobber app the same way, with its own callback URL.
