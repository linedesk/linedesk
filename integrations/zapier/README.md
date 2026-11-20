# Linedesk on Zapier

A Zapier app (Zapier Platform CLI, `zapier-platform-core` 19) that connects a Linedesk workspace to any app on Zapier: Jobber, Housecall Pro, Clio, HubSpot, Salesforce, Google Sheets and the rest.

One app serves every Linedesk install, Cloud and self-hosted: the Linedesk address is a field of each connection. Integrations › Zapier shows a workspace the steps; Server admin › System › Zapier holds the link to the app that workspaces open (none by default: then the steps show no link) and tells a self-hoster whether Zapier can reach the server (an https address on the internet, and outbound to `hooks.zapier.com`). Nothing else is set up on a server.

- **Instant triggers (REST hooks):** Call Started (an answered phone call, 3 s in), During-Call Lookup (each lookup the assistant asked its during-call webhook, with the answer), Call Finished (about 20 s after the call: caller, summary, next steps, bookings, transcript, a link and a 24-hour recording link). Turning a Zap on subscribes Zapier's hook URL (`integration.subscribe`), turning it off ends it (`integration.unsubscribe`). Test calls and spam send nothing. Zapier cannot answer in time, so Call Started and During-Call Lookup only notify: the greeting and lookup answers come from the assistant's webhooks (docs/webhooks.md). Samples come from `GET /v1/integrations/samples/<event>`.
- **Every public action of the API:** one Zapier action or search per public action, generated from the registry into `generated/actions.json` (`pnpm zapier:generate` at the repo root; `lib/generated.js` builds them). Ids are dropdowns (`triggers/options.js`, `GET /v1/integrations/options/<kind>`). Run Any Action runs any public action by name with fields from `GET /v1/openapi.json`.
- **Searches:** Find Contact (by phone number, with Find or Create Contact), Find Call (by id), Find Team Members, Find Free Slots.
- **Connection:** the Linedesk address (default `https://app.linedesk.ai`) and a workspace API key (Integrations › API keys; Member is enough). The test is `GET /v1/api-key`; the connection is labelled with the workspace name.

How the server side works (subscriptions, delivery, why only Zapier's host): `docs/api.md`, Integrations.

This folder is not part of the pnpm workspace or the Docker images; it has its own `package.json` and lock file.

## Build and test

```sh
cd integrations/zapier
npm ci
npm test          # node:test with nock: no network, no Zapier account
```

The first test validates the app definition against Zapier's schema, as `zapier validate` does. The others run the triggers, searches and actions against a mocked Linedesk: subscribe and unsubscribe for each event, the samples, the dropdowns, the connection test and its label, a refused key, Find Contact, Find Call, generated actions (field types, phone numbers, line items) and Run Any Action. CI runs them in the `check` job, with `pnpm zapier:generate --check`.

The server side has its own tests: `apps/api/test/integrations.test.ts` (needs Postgres, `pnpm db:up`).

## Environment

The app has no environment variables on Zapier (`zapier env:set` is not needed): the Linedesk address and the API key are fields of each user's connection. On the Linedesk server only the link to the app is set, in Server admin › System › Zapier (`zapierApp.set`); `WEBHOOK_ALLOW_PRIVATE_URLS=true` (development only) also lets a subscription point at a host other than `hooks.zapier.com`.

## Push to Zapier

The maintainers' release pipeline pushes, promotes and migrates the app when a production release changed this folder; its version is `1.<minor>.<patch>` of the release tag. By hand (a test version, or before the workflow is set up), with a deploy key (Zapier developer platform › Settings › Deploy Keys) from a password manager or the Keychain, put into the environment only for the command, never into a file of this repo:

```sh
cd integrations/zapier
export ZAPIER_DEPLOY_KEY=…   # from your secret store
npx zapier-platform-cli@19.3.0 link        # once: pick Linedesk; writes .zapierapprc (ignored by git)
npm ci && npm test
npm pkg set version=1.1.99   # a version that is not on Zapier yet
npx zapier-platform-cli@19.3.0 validate
npx zapier-platform-cli@19.3.0 push
```

A pushed version is private until it is promoted (`promote <version>`); users of an older version move with `migrate <old> <new>`.

Try it on staging before production: in the Zap editor, connect with the staging address and a staging API key, turn a Zap with a Linedesk trigger on, make a phone call to the staging number, and check the Zap's history. Integrations › API keys lists the Zap's subscription; removing it there stops it.

## Invite users (private app)

Until the app is public, people use it by invitation:

- `zapier users:add someone@example.com <version>`, or
- `zapier users:links` for a link anyone can use to join (good for a first group of customers). Put the link for all versions into Server admin › System › Zapier of each install that offers the app; the setup guide in Integrations › Zapier opens it. After the public listing, change it to the app's page.

## Public listing

To list Linedesk in Zapier's app directory (https://docs.zapier.com/platform/publish/integration-publishing-requirements):

1. Polish: app logo (256×256 PNG), description, homepage, category, help links for every field (the API key help points to Integrations › API keys). Every trigger and action has a sample and clear labels (done in this app).
2. Self-checks: `zapier validate` without warnings; every trigger, search and action used in a live Zap.
3. Users: Zapier asks for active users on the private version (usually a few live Zaps from people outside the team) before review.
4. Submit for review in the developer platform (Integration › Publishing). Zapier tests it with a test account: give them a Linedesk Cloud workspace with an API key and a phone number they can call, or a test call that reaches the trigger.
5. After approval the app is in beta for a while (Zapier's rule), then fully public. Keep the docs URL and support email (`support@linedesk.ai`) current.
