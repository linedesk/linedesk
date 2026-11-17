# HubSpot app

The HubSpot app that Linedesk workspaces connect to (Integrations › HubSpot). HubSpot builds apps only from a
project uploaded with the HubSpot CLI; this folder is that project.

- Owner account: the Linedesk HubSpot developer account (portal 000000000, EU data center).
- Change the app: edit `src/app/app-hsmeta.json`, then `hs project upload` from this folder (`hs account auth` once
  per machine, with a personal access key of that account).
- Client ID and secret: HubSpot › Development › Projects › linedesk › Linedesk › Auth. They go into Server admin ›
  Providers (never into this repo).
- A new install origin needs its redirect URL `<origin>/v1/apps/callback/hubspot` in `redirectUrls`.
- Publishing: see `PUBLISHING.md` (create the production app, Marketplace listing draft, review checklist, gaps).
