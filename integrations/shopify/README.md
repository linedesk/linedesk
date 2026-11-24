# Shopify app

The Shopify app that Linedesk workspaces connect their store to (Integrations › Shopify). During calls the assistant
finds the caller's orders and the store's products; after calls Linedesk adds the call as a note on the Shopify
customer (docs/crm-sync.md, "Shopify"). This app is not listed in the Shopify App Store: stores install it from
Linedesk.

## Create the app

1. Sign up for a Shopify Partner account at [dev.shopify.com](https://dev.shopify.com/dashboard) (free). Create a
   development store there for tests (Stores › Add store › Development store); it can hold test orders and products.
2. Apps › Create app › Create app manually, name `Linedesk`.
3. Configuration:
   - App URL: `<origin>/#integrations/shopify`, for example `https://app.linedesk.ai/#integrations/shopify`.
   - Allowed redirection URL: `<origin>/v1/apps/callback/shopify`. Server admin › Providers › Shopify shows the exact
     URL of the install. One app per origin (production, staging, each self-hosted install).
   - Embedded in Shopify admin: off. **Use legacy install flow: on** (Linedesk connects with the authorization code
     grant; Shopify's managed install is for embedded apps).
   - Webhooks API version `2026-10`. Compliance webhooks (customer data request, customer redact, shop redact):
     `<origin>/v1/apps/webhook/shopify`, set in `shopify.app.toml` and released with `shopify app deploy` (below).
     With the legacy install flow Shopify allows no app-wide `app/uninstalled` subscription: Linedesk subscribes each
     store itself right after it connects (same URL). Shopify signs every delivery with the client secret.
4. API access › Protected customer data access: request access to name, email, phone and address, with the reason
   "the phone assistant finds a caller's orders and tells them where an order is". Without it only development stores
   answer these fields.
5. Copy the **Client ID** and the **Client secret** from the app's overview and paste them into Server admin ›
   Providers › Shopify (never into this repo or `.env`; the secret is stored encrypted).
6. Distribution: custom distribution for one store, or public (unlisted) for many. Connect from Integrations › Shopify
   with the store's myshopify.com address.

## Limits

- Tokens: expiring offline tokens (one hour, rotating refresh token). A refresh token not used for 90 days runs out:
  the connection then needs to be connected again.
- Orders older than 60 days need the `read_all_orders` scope, which Shopify grants on request.
- Every request names the Admin API version (`SHOPIFY_API_VERSION` in `packages/connectors/src/shopify.ts`). Shopify
  supports each version for 12 months: move it forward each year with the changelog at shopify.dev/changelog.

## Configure with the Shopify CLI

The Dev Dashboard form has no field for the compliance webhooks. Put the app's settings into a `shopify.app.toml`
(outside this repo, it names the app's client ID) and release them:

```toml
client_id = "<client ID>"
name = "Linedesk (Staging)"
application_url = "<origin>/#integrations/shopify"
embedded = false

[access_scopes]
use_legacy_install_flow = true
scopes = "read_customers,write_customers,read_orders,write_orders,read_returns,write_returns,read_products,read_inventory,read_legal_policies"

[auth]
redirect_urls = ["<origin>/v1/apps/callback/shopify"]

[webhooks]
api_version = "2026-10"

  [[webhooks.subscriptions]]
  compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]
  uri = "<origin>/v1/apps/webhook/shopify"
```

`npx @shopify/cli app deploy --path <dir> --allow-updates --no-build` (the first run logs in with a code you confirm in
the browser). `npx @shopify/cli app env show --path <dir>` prints the client ID and secret: pipe the secret straight
into Server admin's store, never into a file or a chat.
