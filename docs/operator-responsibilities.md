# Your responsibilities when you run Linedesk

Whoever runs a Linedesk instance, a business or an agency running it for clients, decides who it talks to, what it says and what it keeps. This page lists what that means. It is not legal advice. Laws differ between countries and states, so check the rules that apply to you and your callers.

## Callers' data

Calls, recordings, transcripts, summaries and contacts are stored on your server and sent only to the providers you configure, on your own accounts. The software sends nothing to us on its own. So you are responsible for that data under privacy laws such as the GDPR or the CCPA:

- Tell callers how you use their data, for example in your privacy policy. Transcripts and call summaries are personal data too, not only the recordings; under the GDPR you need a legal basis for each.
- Sign data processing agreements with your providers where your law requires them.
- Some speech and language model providers process data outside the EU. If your law requires it, check their transfer safeguards (for example the EU Standard Contractual Clauses) and use their zero-retention options where they have them. For OpenRouter, Server admin › Providers has "Zero data retention only" (`OPENROUTER_ZERO_DATA_RETENTION`, on by default).
- Keep recordings only as long as you need them (Settings › Recordings).
- If you run Linedesk for clients, cover their callers' data in your contract with them.

## When a caller asks for their data

- Export: Settings › Export gives the calls of a date range as a CSV file (time, caller, number, outcome, summary and next steps; owners and admins).
- Delete: delete the caller's calls in the inbox and their contact. A deleted call or contact can be restored for 30 days, then it is erased for good, the recording with it. Owners and admins can also erase a call at once.

## What can leave your server

Only these, and each can be turned off or sent to you instead:

- **Report a bug and Request a feature** (Help menu, also the `feedback.send` action through the API, MCP or CLI): an email with the text the person wrote, the page, the app and server versions, your server's address, the workspace name and id, the sender's id and a screenshot if they attach one. Phone numbers, email addresses and keys in the text are masked first. The sender's own address goes only when they give it to be answered at. By default it goes to the Linedesk team (support@linedesk.ai). Set `FEEDBACK_EMAIL` to your own support address, or to `off` to keep reports on your server only.
- **Setup reports**: when an AI agent sets up your server through a setup link, it can send the Linedesk team a short report of what failed or was slow. It is sent only after the admin says yes to the exact text, and it is redacted (no keys, phone numbers, email addresses or business details). Set `SETUP_FEEDBACK_URL` to your own address, or to `off` to keep them on your server only.
- **Error reports** go to Sentry only when you set `SENTRY_DSN`, to your own Sentry project. They are off by default.

## Recording

Many places require that callers are told about a recording, and some, including several US states such as California, require everyone's consent. In some countries, such as Germany (§ 201 of the Criminal Code), recording a call without consent is a crime, and a notice at the start of the call may not be enough. Linedesk says "This call may be recorded and transcribed." at the start of a recorded call by default ("Say that the call may be recorded" in Settings › Recordings). Leave it on unless you tell callers another way. If you can't meet the rules for your callers, turn recording off.

## AI disclosure

By default the assistant says it is an AI in its greeting. Some US states require this, and so does the EU AI Act. Leave it on unless you are sure you don't need it.

## Calls Linedesk makes

Calls with an AI voice fall under robocall and telemarketing laws in many places, such as the TCPA in the United States. Only let Linedesk call people who asked to be called or already do business with you.

## Emergencies

Linedesk is not an emergency service and can fail like any phone line. Don't make it the only way people can reach you in an emergency. If you get emergency calls, set up an on-call contact and tell callers to hang up and dial the emergency number when someone is in danger.

## What the assistant says

The assistant works from your instructions and can make mistakes. Keep them accurate and review its calls in the inbox. You are responsible for what it tells your callers.
