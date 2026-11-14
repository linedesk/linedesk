# Security policy

Linedesk handles phone calls, recordings, transcripts and calendar access for businesses, so we take reports seriously.

## Reporting a vulnerability

Please do not open a public issue. Instead:

- Email **SECURITY_CONTACT_PLACEHOLDER** (address to be added before the repository is public), or
- use GitHub's "Report a vulnerability" button on the Security tab of this repository.

Include what you found, how to reproduce it, and the version or commit you tested. We confirm receipt within 3 working days, keep you updated while we fix it, and credit you in the release notes unless you prefer otherwise. Please give us a reasonable time to ship a fix before you disclose anything publicly.

## Supported versions

Until 1.0, only the latest release and `master-dev` get security fixes.

## Scope

In scope: this repository (API, web app, voice agent, packages) and the self-host stack it ships (`docker-compose.yml`, Caddy configuration, images).

Out of scope: vulnerabilities in third-party providers (carriers, speech, language model, calendar), denial of service by volume, and findings that need an already compromised server or a malicious instance admin.

## For self-hosters

- Set every secret in `.env` yourself (`BETTER_AUTH_SECRET`, `SECRETS_KEY`, `POSTGRES_PASSWORD`, `AGENT_API_TOKEN`, the LiveKit keys); the API refuses the placeholders where it can.
- Keep `SECRETS_KEY` safe and backed up: it encrypts provider keys stored in the admin area.
- Close sign-up (`AUTH_SIGNUP_ENABLED=false`) once your accounts exist.
