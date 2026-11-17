# Slack app

The Slack app that Linedesk workspaces connect to (Integrations › Slack). It has one scope, `incoming-webhook`:
when a business connects, Slack asks which channel to post to, and Linedesk posts every finished phone call there
(docs/crm-sync.md, "Slack").

- The app: "Linedesk" (app ID A0123456789), made from `manifest.json` in this folder. Change the app by editing the
  manifest here first, then paste it under api.slack.com/apps › Linedesk › App Manifest.
- Icon: upload `brand/linedesk-icon-512.png` under Basic Information › Display Information (a manifest cannot carry
  the icon).
- Client ID and secret: Basic Information › App Credentials. They go into Server admin › Providers › Slack (never
  into this repo). Slack checks the secret only when a business connects; the provider test checks the client ID.
- Workspaces other than the app's own: Manage Distribution › Activate Public Distribution. Full setup for production and the
  Slack Marketplace: [PUBLISHING.md](PUBLISHING.md).
- Keep token rotation off: the bot token then does not run out, and Linedesk stores it only to uninstall the app on
  disconnect.
- A new install origin needs its redirect URL `<origin>/v1/apps/callback/slack` in `oauth_config.redirect_urls`.
- A self-hosted install makes its own Slack app from this manifest, with its own redirect URL.
