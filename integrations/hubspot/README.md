# HubSpot app

The HubSpot app that Linedesk workspaces connect to (Integrations › HubSpot). HubSpot builds apps only from a
project uploaded with the HubSpot CLI; this folder is that project.

- Owner account: the Linedesk HubSpot developer account (EU data center).
- Change the app: edit `src/app/app-hsmeta.json`, then `hs project upload` from this folder (`hs account auth` once
  per machine, with a personal access key of that account).
- Client ID and secret: HubSpot › Development › Projects › linedesk › Linedesk › Auth. They go into Server admin ›
  Providers (never into this repo).
- This project is production only (redirect URL of app.linedesk.ai). The maintainers' staging app is a separate
  project kept with their internal files, so a staging disconnect (which uninstalls the app from the portal) never
  touches production. Keep the scopes of both projects the same.
- A new install origin needs its redirect URL `<origin>/v1/apps/callback/hubspot` in `redirectUrls`.
