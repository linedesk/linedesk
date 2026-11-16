# Linedesk on Zapier

A Zapier app (Zapier Platform CLI, `zapier-platform-core` 19) that connects a Linedesk workspace to any app on Zapier: Jobber, Housecall Pro, Clio, HubSpot, Salesforce, Google Sheets and the rest.

- **Trigger, instant:** Call Finished. A REST hook: turning a Zap on subscribes Zapier's hook URL (`integration.subscribe`), turning it off ends it (`integration.unsubscribe`). Linedesk POSTs each finished phone call about 20 seconds after it ends: caller, summary, next steps, bookings, transcript, a link to the call and a 7-day recording link. Test calls and spam send nothing. Samples come from `GET /v1/integrations/calls`.
- **Search:** Find Contact (by phone number), with Find or Create Contact.
- **Actions:** Create Contact (`contact.create`), Mark Call Done (`call.markDone`).
- **Connection:** the Linedesk address (default `https://app.linedesk.ai`; a self-hosted server puts its own) and a workspace API key (Workspace settings › Developers; Member is enough). The test is `GET /v1/api-key`; the connection is labelled with the workspace name.

How the server side works (subscriptions, delivery, why only Zapier's host): `docs/api.md`, Integrations.

This folder is not part of the pnpm workspace or the Docker images; it has its own `package.json` and lock file.

## Build and test

```sh
cd integrations/zapier
npm ci
npm test          # node:test with nock: no network, no Zapier account
```

The first test validates the app definition against Zapier's schema, as `zapier validate` does. The others run each trigger, search and action against a mocked Linedesk: subscribe and unsubscribe, the sample calls, the connection test and its label, a refused key, Find Contact, Create Contact and Mark Call Done.

The server side has its own tests: `apps/api/test/integrations.test.ts` (needs Postgres, `pnpm db:up`).

## Environment

The app has no environment variables on Zapier (`zapier env:set` is not needed): the Linedesk address and the API key are fields of each user's connection. On the Linedesk server nothing new is needed either; `WEBHOOK_ALLOW_PRIVATE_URLS=true` (development only) also lets a subscription point at a host other than `hooks.zapier.com`.

## Push to Zapier

Needs a Zapier account with the developer platform (free). The CLI signs in with a deploy key (Zapier developer platform › Settings › Deploy Keys) read from `ZAPIER_DEPLOY_KEY`; keep the key in a password manager or the Keychain and put it into the environment only for the command, never into a file of this repo:

```sh
npm install -g zapier-platform-cli
cd integrations/zapier
export ZAPIER_DEPLOY_KEY=…   # from your secret store
zapier register "Linedesk"   # once: creates the integration and writes .zapierapprc (ignored by git)
#   or, when it exists already: zapier link   (pick Linedesk; writes .zapierapprc)
npm ci && npm test
zapier validate
zapier push                  # uploads this version (package.json "version")
```

`zapier login` (browser) works instead of the deploy key. Later versions: raise `version` in `package.json`, `zapier push`, then `zapier promote <version>` and `zapier migrate <old> <new>` to move existing users.

Try it on staging before production: in the Zap editor, connect with the staging address and a staging API key, turn a Zap with Call Finished on, make a phone call to the staging number, and check the Zap's history. Workspace settings › Developers lists the Zap's subscription; removing it there stops the calls.

## Invite users (private app)

Until the app is public, people use it by invitation:

- `zapier users:add someone@example.com 1.0.0`, or
- `zapier users:links` for a link anyone can use to join (good for a first group of customers).

## Public listing

To list Linedesk in Zapier's app directory (https://docs.zapier.com/platform/publish/integration-publishing-requirements):

1. Polish: app logo (256×256 PNG), description, homepage, category, help links for every field (the API key help points to Workspace settings › Developers). Every trigger and action has a sample and clear labels (done in this app).
2. Self-checks: `zapier validate` without warnings; every trigger, search and action used in a live Zap.
3. Users: Zapier asks for active users on the private version (usually a few live Zaps from people outside the team) before review.
4. Submit for review in the developer platform (Integration › Publishing). Zapier tests it with a test account: give them a Linedesk Cloud workspace with an API key and a phone number they can call, or a test call that reaches the trigger.
5. After approval the app is in beta for a while (Zapier's rule), then fully public. Keep the docs URL and support email (`support@linedesk.ai`) current.
