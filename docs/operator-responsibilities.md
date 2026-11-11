# Your responsibilities when you run Linedesk

Linedesk answers phone calls for a business. Whoever runs an instance (the business itself, or an agency that runs it for clients) decides who it talks to, what it says and what it keeps. This page lists what that means. It is not legal advice: laws differ between countries and states, so check the rules where your business and your callers are, and ask a lawyer if you are unsure.

## You are in charge of the data

On a self-hosted instance, calls, recordings, transcripts and contacts are stored on your server and sent only to the providers you configure (phone carrier, speech, language model, voice, calendar), on your own accounts. We, the Linedesk project and Sauerbier & Gutberlet GmbH, never receive any of it, and the software does not report back to us.

That makes you responsible for that data under privacy laws such as the GDPR, the CCPA and similar laws elsewhere. In practice:

- **Tell callers** how you use their data, for example in your own privacy policy.
- **Have agreements with your providers.** Most carriers and AI providers offer a data processing agreement; sign it where your law requires one.
- **Keep data only as long as you need it.** Linedesk deletes recordings after the retention period you set under Settings › Recordings. Shorter is better.
- **Answer requests.** If a caller asks to see or delete their data, you can find and delete their calls and contact in the inbox.
- **If you run Linedesk for clients,** you usually process their callers' data on their behalf. Put that in your contract with them, including a data processing agreement where required.

## Recording calls

Linedesk records calls unless you turn recording off for the assistant. Many places require that callers are told about a recording, and some require that everyone on the call agrees to it. This includes several US states (for example California, Florida, Illinois, Pennsylvania and Washington) and many countries.

If you record, say so at the start of the call, for example in the greeting: "This call is recorded." If you can't make sure you meet the rules for all your callers, turn recording off. Transcripts and summaries are stored either way, so they count as call data too.

## Telling callers they are talking to an AI

The assistant says it is an AI in its greeting by default (Settings › Assistant › Greeting). Some US states and other countries require this, and the EU AI Act requires it from August 2026 for systems that talk to people. Leave it on unless you are sure you don't need it.

## Calls Linedesk makes

Linedesk can call people back and call your team for urgent handovers. Calls with an AI or artificial voice fall under telemarketing and robocall laws in many places, such as the TCPA in the United States. Only let Linedesk call people who asked to be called or already do business with you, and never use it for cold calls or marketing campaigns.

## Not an emergency service

Linedesk is not a replacement for 911 or any other emergency number, and it can fail like any software or phone line. Don't rely on it as the only way people can reach you in an emergency. If your business gets calls about emergencies, tell callers in the greeting or instructions to hang up and dial the emergency number when someone is in danger, and set up an on-call contact for urgent handovers.

## What the assistant says

The assistant works from the instructions and business information you give it. It can make mistakes. Review its answers in the inbox, keep its instructions accurate, and don't let it give medical, legal or financial advice or make promises your business can't keep. You are responsible for what it tells your callers.

## Your providers' terms

You use the carrier, AI and calendar providers on your own accounts and under their terms, including their acceptable use policies and any rules on registering phone numbers or messaging (for example 10DLC in the United States).

## No warranty

Linedesk is free software under the [AGPL-3.0](../LICENSE) and comes without any warranty, to the extent the law allows. See sections 15 and 16 of the license.

Questions or something missing here? Write to [legal@linedesk.ai](mailto:legal@linedesk.ai).
