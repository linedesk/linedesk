# Roadmap

What we plan to work on next. No dates: the order can change with what users ask for. To suggest something, open a [feature request](https://github.com/linedesk/linedesk/issues/new/choose); to work on an item, comment on its issue first ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Now

- **The public release:** the code in this repository with every release, tagged releases with release notes, GitHub Discussions for questions, and a first set of good first issues.
- **Faster answers on the phone:** the greeting in under 1.5 seconds and most replies in about a second.
- **More calls at once on one install:** voice agent workers on separate servers.

## Next

- **Phone:** warm transfers through Twilio (Telnyx only today); numbers in more countries than the US, Canada and Puerto Rico (needs each carrier's identity checks per country).
- **Languages:** more languages for the assistant, a native-speaker review of the translated app, right-to-left layouts.
- **Setup:** an OpenAI voice for the three-stage pipeline, so one OpenAI key covers speech, model and voice; the business address with autocomplete, which sets the time zone and the holiday calendar; a heads-up before a closed day.
- **Inbox:** an optional daily digest instead of one email per call; open the calls behind a number in Insights; book an appointment and filter calls right from the inbox.
- **Business tools:** CRM sync in both directions (today Linedesk only writes calls to the CRM; see [docs/crm-sync.md](docs/crm-sync.md)).
- **Agencies:** a partner's own brand on the sign-in page and in emails, own domains, own sender domains and own provider keys ([docs/white-label.md](docs/white-label.md)).
- **AI tools:** Linedesk in the Claude and ChatGPT connector directories.

## Later

- More channels on the same inbox: WhatsApp, SMS and email.
- More speech-to-speech models (for example Gemini Live) next to OpenAI Realtime.
- A smaller voice agent image, and Electric's storage kept across restarts.
