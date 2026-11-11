# Roadmap

Linedesk is in active development ahead of its first public release. This page says what works, what is being finished and what comes later. It changes often. The code is not public yet; "works today" refers to our development version. Last updated: November 2026.

## Works today

**Calls**

- Real phone calls through Telnyx or Twilio, with LiveKit SIP and a voice agent
- Configurable voice pipeline: Deepgram, models via OpenRouter, ElevenLabs voices with a voice picker
- Assistant knowledge: website import, services and prices, FAQs, documents, and a list of questions it could not answer
- Bookings in Google Calendar and Microsoft 365 during the call, with appointment types, working hours, buffers and minimum notice
- Transfers to named teammates with plain-language conditions and a fallback each; warm transfer of urgent calls
- Returning callers recognised and greeted by name
- Structured input: confirmed names, numbers, addresses, emails and dates, keypad digits and optional keypad menus
- Call summaries, next steps, urgency flag, recordings and call evaluation
- Limits that keep costs in check: call length, silence, parallel calls, messages and bookings per call
- Browser test calls with a live transcript, no phone number needed

**Inbox and team**

- Local-first, keyboard-first inbox that works offline and installs as an app
- Contacts: call history, CSV import, merging duplicates, blocking and spam handling
- Teams: invitations, roles, assigning calls, audit log
- Push notifications for new calls
- Onboarding: business details, hours, phone number, calendar, test call

**Platform**

- Sign-in with email code, password, passkeys, Google, Microsoft and OpenID Connect
- Public API with OpenAPI description, MCP server, signed webhooks
- Self-hosting with one Compose file, memory and CPU limits, updates without downtime

## Being finished for the first release

- Voice latency on real phone lines: faster greeting and replies
- Live tests of bookings and transfers over real phone lines
- Security review and hardening
- Self-hosting guide and the first public release of the code

## Next

- More transfer rules ("caller asks for a person", fixed hours)
- CRM sync, HubSpot first (webhooks cover other CRMs today)
- Warm transfer through Twilio
- Hosted version ([waitlist](https://linedesk.ai))

## Later

- More channels on the same foundation: WhatsApp (including calls), SMS, email
- More telephony options: Plivo, bring-your-own SIP
- More calendars: CalDAV
- Templates per trade (plumber, dental practice, salon)

Have a use case that is missing? Open an issue.
