# Zoho CRM client

The Zoho API console client that Linedesk workspaces connect to (Integrations › Zoho CRM). When a business connects,
Linedesk logs every finished phone call on the caller's Zoho CRM contact, and adds new callers as contacts
(docs/crm-sync.md, "Zoho CRM").

## Create the client

1. Sign in at [api-console.zoho.com](https://api-console.zoho.com/) with any Zoho account (free). Use the US console:
   every connect starts at accounts.zoho.com.
2. Add Client › **Server-based Applications**:
   - Client Name: `Linedesk`. Homepage URL: the install's address, for example `https://app.linedesk.ai`.
   - Authorized Redirect URIs: `<origin>/v1/apps/callback/zoho`, for example
     `https://app.linedesk.ai/v1/apps/callback/zoho`. Server admin › Providers › Zoho CRM shows the exact URL of the
     install. Use one client per origin (production, staging, each self-hosted install).
3. Settings tab: turn on every data centre (Multi-DC) and tick **Use the same OAuth credentials for all data
   centers**. Without it a business whose Zoho account is in the EU, India, Australia, Japan, Canada, Saudi Arabia,
   the UK, Singapore or the UAE cannot connect, or gets a client secret that differs per data centre (Linedesk stores
   one). Zoho's China data centre is not supported.
4. Client Secret tab: copy the **Client ID** and the **Client Secret**.
5. Paste them into Server admin › Providers › Zoho CRM (never into this repo or `.env`; the secret is stored encrypted)
   and click Test. The test asks the US token endpoint with a made-up refresh token: Zoho names a wrong client ID or
   secret (`invalid_client`, `invalid_client_secret`), so a wrong pair fails the test.

There are no scopes to set on the client: Linedesk asks for them on the consent page (`ZOHO_SCOPES` in
`packages/connectors/src/zoho.ts`: contacts, creating calls, the search API and reading the org).

## Limits

- Access tokens last an hour; the refresh token does not run out. Zoho keeps at most 20 refresh tokens per Zoho user
  and client: a 21st connect by the same person ends the oldest grant.
- Zoho allows 10 access tokens per refresh token in 10 minutes; Linedesk refreshes only when the stored token is
  about to run out.
- API calls count against the business's own Zoho CRM plan (credits per day, 5,000 on the free edition; one push uses
  about four). A business that runs out sees "Zoho CRM asked to slow down"; the push is retried.
- Disconnecting in Linedesk revokes the refresh token. Zoho has no API that removes the client from an org: a business
  removes it at accounts.zoho.com › Sessions › Connected Apps; the next refresh then removes the connection.
- A contact's company is a link to an Account record in Zoho, so Linedesk does not fill it.
