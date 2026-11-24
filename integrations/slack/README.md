# Slack app

The Slack app that Linedesk workspaces connect to (Integrations › Slack). It has one scope, `incoming-webhook`:
when a business connects, Slack asks which channel to post to, and Linedesk posts every finished phone call there
(docs/crm-sync.md, "Slack").

- The app: "Linedesk", made from `manifest.json` in this folder. Change the app by editing the
  manifest here first, then paste it under api.slack.com/apps › Linedesk › App Manifest.
- Icon: upload `brand/linedesk-icon-512.png` under Basic Information › Display Information (a manifest cannot carry
  the icon).
- Client ID, client secret and signing secret: Basic Information › App Credentials. They go into Server admin ›
  Providers › Slack (never into this repo). Slack checks the client secret only when a business connects; the
  provider test checks the client ID.
- Event Subscriptions: the request URL `<origin>/v1/apps/events/slack` with the bot events `app_uninstalled` and
  `tokens_revoked`, so a business that removes the app inside Slack is shown as not connected at once. Save the
  signing secret in Server admin first: Slack checks the URL when you save it, and without a signing secret the URL
  answers 404 (Linedesk then notices an uninstall only at the next post).
- Workspaces other than the app's own: Manage Distribution › Activate Public Distribution.
- Keep token rotation off: the bot token then does not run out, and Linedesk stores it only to uninstall the app on
  disconnect.
- A new install origin needs its redirect URL `<origin>/v1/apps/callback/slack` in `oauth_config.redirect_urls`
  and its events URL in `settings.event_subscriptions.request_url`.
- `manifest.json` lists only the production URLs. The maintainers' own staging app uses their staging origin:
  they paste a version kept with their internal files (the same manifest with those URLs) instead. Keep the two
  in step.
- A self-hosted install makes its own Slack app from this manifest, with its own redirect and events URLs.
