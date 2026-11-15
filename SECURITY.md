# Security policy

Linedesk handles phone calls, recordings, transcripts and calendar access for businesses, so we take reports seriously.

## Supported versions

Only the latest release gets security fixes. Before you report, check that the issue is still there in the latest release (or on `master-dev`, which becomes the next one). Self-hosters: update to the latest release to get a fix.

## Reporting a vulnerability

Please report privately. Do not open a public issue, pull request or discussion.

- Email **security@linedesk.ai**. It reaches the maintainers directly.
- Or use GitHub private vulnerability reporting ("Report a vulnerability" on the repository's Security tab), where it is enabled.

Include what you found, how to reproduce it, the version or commit you tested, and what an attacker could do with it. Please don't access or change other people's data, and don't test against installs you don't run yourself; your own self-hosted install is the place to try things.

## What to expect

- We confirm receipt within 3 working days.
- Within 10 working days we tell you whether we can reproduce it and how serious we think it is.
- We keep you updated while we fix it, ship the fix in a release, and credit you in the release notes unless you prefer otherwise.
- Please give us a reasonable time to ship a fix before you disclose anything publicly; we agree on a date with you.

There is no bug bounty: we can't pay for reports.

## Scope

In scope: this repository (API, web app, voice agent, packages) and the self-host stack it ships (`docker-compose.yml`, Caddy configuration, images).

Out of scope: vulnerabilities in third-party providers (carriers, speech, language model, calendar), denial of service by volume, and findings that need an already compromised server or a malicious instance admin.

## For self-hosters

- Set every secret in `.env` yourself (`BETTER_AUTH_SECRET`, `SECRETS_KEY`, `POSTGRES_PASSWORD`, `AGENT_API_TOKEN`, the LiveKit keys); the API refuses the placeholders where it can.
- Keep `SECRETS_KEY` safe and backed up: it encrypts provider keys stored in the admin area.
