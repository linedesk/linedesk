# Translations

Linedesk's web app and emails speak English, Español, Português, Français, Deutsch and 日本語. English is
the source and the fallback; every other language is translated by AI before each release, screen by screen, and
improved by people.

## How it works

- All user-visible text lives in `packages/i18n/locales/<locale>/<namespace>.json` as ICU MessageFormat, one flat,
  alphabetically sorted object per namespace (`inbox`, `call`, `account`, `email` and so on). The key's first segment
  is the namespace: `inbox.row.markRead` is `row.markRead` in `locales/en/inbox.json`.
- Code only ever names keys: `t('inbox.row.markRead')` and `<T k="…" values={{ b: chunks => <b>{chunks}</b> }} />` in
  the web app (`useT()` and `T` from `@linedesk/i18n/react`), `getT(locale).t('…')` on the server
  (`@linedesk/i18n/server`). Keys are typed: a typo fails `pnpm typecheck`.
- Dates, times, numbers, amounts, lists and durations are never written into a message. They come in as arguments,
  formatted with `useFormat()` (web) or `getT(locale).format` (server), which use `Intl` with the reader's language.
- `packages/i18n/locales.ts` is the one list of languages. `glossary.json` fixes the product terms per language and
  the words that are never translated; `STYLE.md` is the tone per language. Every translation follows both.
- `i18n.lock.json` records, per language and key, a hash of the English a translation was made from and of the
  translation itself, and whether the AI or a person wrote it.

### The pipeline

1. A pull request changes only English (`locales/en/`). `pnpm i18n:check` runs in CI on every pull request: valid
   catalogs, every key used and defined, no new hardcoded English. Missing translations are fine on the trunk: the
   new strings show in English until the next release.
2. Before every release, the release translation pass below translates what is new or changed. Its commit goes to
   the trunk like any other change.
3. The maintainers' release pull request runs `pnpm i18n:check --complete` in its own job,
   `release-translations` (in the maintainers' copy): every key in every language present and made from the
   current English, and `hardcoded-baseline.json` empty (no web app file with hardcoded English left). It turns red
   otherwise and lists each missing or stale key, and each file still in the baseline, in the log and the run's
   summary. Releases never ship untranslated or hardcoded text; a red release pull request is not merged. The one
   exception is a hotfix (below).

### Hotfixes: no translation pass

A hotfix release skips the release translation pass (decided 2026-11-15): a fix for production must not wait for
translations. The fix still goes to the trunk first, like every change; then label the release pull request
`hotfix` (`--label hotfix` on `gh pr create`, or add the label on GitHub). The
`release-translations` job reads the label when it runs and then passes without checking, with a note in the run's
summary; if it already ran red before the label was added, re-run that job (`gh run rerun <run id> --failed`, or Re-run
jobs on GitHub). Everything else on the release pull request still runs. New or changed strings show in English in
production until the next regular release, whose pass covers them (`pnpm i18n:changed` counts from the newest `v*`
tag, the hotfix's included, so pass `--since <the last regular release's tag>`). The label exists once in the
repository (`gh label create hotfix --description "Release without the translation pass"`); only a maintainer adds
it.

### The release translation pass (required before every release)

Done by the maintainer who releases (or an AI session for them), on the trunk, before opening the release pull
request:

1. `pnpm i18n:changed` lists every English key added or changed since the last release (the newest `v*` tag; or
   `--since <ref>`), with the files that render it and the languages where a person wrote the translation.
2. For each key, read the component that renders it: the surrounding UI code and the neighbouring strings, so the
   translation fits what the screen does (a button, a title, a toast, a sentence around an argument).
3. Open each screen in every language: the dev server (`pnpm dev`, or a session's own database from
   `scripts/dev-env.sh`) in a browser whose language is set per locale, and take screenshots.
4. Translate with that context, following `glossary.json` and `STYLE.md`. Keep ICU arguments, tags and plural forms
   (`pnpm i18n:check` says when something is off).
5. Check the layout at desktop width and at 390 px: German and French run long, Japanese breaks lines differently.
6. Never overwrite a string a person wrote (`i18n:changed` names those languages): when its English changed, propose
   a change in the pull request and leave the decision to a native speaker.
7. Record the new translations with `pnpm i18n:lock --by ai` (it keeps every unchanged string a person wrote as
   theirs), run `pnpm i18n:check --complete` until it passes, and merge the change into the trunk.
8. Put the screenshots, or a short summary per language (what was translated, what needs a native check), in the
   release pull request.

`pnpm i18n:translate` is an optional local helper for a first draft: it sends new and changed strings with the
glossary and style guide to Claude, validates each result (it parses, keeps the same arguments, tags and plural
forms, keeps the never-translate terms) and never touches a person's text unless its English changed. It needs your
own `ANTHROPIC_API_KEY` in the environment (`--locale es`, `--ns inbox`, `--dry-run`, `--report <file>`) and runs
nowhere in CI. Its draft still goes through steps 2 to 8.

## Fix a translation

1. Find the key. Open the app with `?lang=en-XA` (development and staging) to see the pseudo-locale: every translated
   string is accented and wrapped in `⟦ ⟧`, so text that is not is still hardcoded English. Or search for the text in
   `packages/i18n/locales/<locale>/`.
2. Edit the JSON file of your language, record it as yours with
   `pnpm i18n:lock --by human --locale <locale> --prefix <key>` and open a pull request. Release passes keep your
   wording; only a change to its English brings it up again, for a native speaker to decide.

Keep the ICU parts exactly as they are: arguments (`{name}`, `{count}`), tags (`<b>…</b>`, `<link>…</link>`) and
`#` inside plurals. Give every plural form your language has (`one`/`other` in English and German, `one`/`many`/
`other` in Spanish, French and Portuguese, only `other` in Japanese). `pnpm i18n:check` tells you when something is
off.

Not a developer? Open a [Translation improvement](https://github.com/linedesk/linedesk/issues/new?template=translation_improvement.yml)
issue with the screen, the current text and the better one.

## Review a whole area

Edit what is wrong. To mark the rest as checked without changing it, a maintainer runs
`pnpm i18n:lock --mark-human <locale> <key-prefix>` (for example `pnpm i18n:lock --mark-human es inbox.`).

A language is shown as "Beta" in the picker until a native speaker has reviewed the core flows:

- sign-in (`auth`)
- the inbox (`inbox`, `shell`)
- the call view (`call`)
- account settings (`account`)

Then remove it from `BETA_LOCALES` in `packages/i18n/locales.ts`.

## Add text as a developer

This applies to every pull request and every session: a maintainer's or a contributor's, a person's or an AI's, automated pull
requests included. `.ts` files count as much as `.tsx`: a label a model or helper builds (`checked ? 'Reopen' : …`),
a fallback (`name ?? 'Assistant'`) and an error message the page shows are all user-visible text.

1. Add the key to `packages/i18n/locales/en/<namespace>.json` (sorted; `pnpm i18n:check` says when it isn't) and
   use it with `t()` or `<T>`. Never edit other languages in a feature pull request: the release translation pass
   does that, with the screen in view, which keeps diffs reviewable.
2. Whole sentences, never pieces glued together: word order differs between languages. Plurals with ICU
   (`{count, plural, one {# call} other {# calls}}`), variants with `select`, markup with tags.
3. Keyboard keys (`E`, `Esc`, `⌘K`), URLs and code stay out of the catalogs; pass them as arguments.
4. A key built at runtime (`t(\`errors.${code}\`)`) needs `// i18n-dynamic: errors.*` next to it, so the check counts
   the prefix as used.
5. Translating is not part of a feature pull request. If you translate anyway (by hand, in an AI session or with the
   optional `pnpm i18n:translate`), record it with `pnpm i18n:lock --by ai` or `--by human`.

### Checks (`pnpm i18n:check`)

- English: valid ICU, sorted keys, no duplicates, no empty strings.
- Code and catalogs: every key the code uses exists, every English key is used (or under an `i18n-dynamic` prefix).
  The web app uses no key of `server.json` (it never loads it in other languages, so the text would be English for
  everyone): such a text moves to a namespace the web app loads, or the API writes it.
- Other languages: no keys English lacks, the same arguments, tags and plural forms, a lock entry for every key.
- `--complete` (release pull requests only): every key translated and current, and `hardcoded-baseline.json` empty.
  A file listed there fails the release with a note to move its strings to keys and use `t()`.
- The ratchet: `hardcoded-baseline.json` counts the user-visible English still in each web app file, every `.ts` and
  `.tsx` file under `apps/web/src` except tests. It is empty now: every file is at 0, a new file starts at 0, and a
  pull request that adds hardcoded English fails `pnpm i18n:check`, which lists each string with its line. After
  moving strings out, `pnpm i18n:check --update-baseline` writes the new counts. Never raise it to pass a check.
- What the scanner counts (`packages/i18n/scripts/scan.ts`, `findHardcoded`): JSX text, text attributes (`title`,
  `placeholder`, `aria-label`, `label`, `alt`, `tooltip`) and `toast(…)`; in all code, a string or template that
  reads like a sentence, and a capitalised word that is returned, chosen, assigned or listed; error messages too; also
  what `join`, `replace` and `replaceAll` are called on (`[\`Address: ${address}.\`, …].join('\n')`). Not
  counted: types, object keys, comparisons, imports, logs, class names, URLs, ids and keys, keyboard keys, `t()` keys
  and the glossary's never-translate words alone. Text that is not UI (an example file whose column names are read
  back, browser messages the code matches, a programming error) gets `// i18n-ignore: <why>` right before its
  statement; the reason is required, the check prints how many there are, and a reviewer questions each new one. It
  is never a way to get a pull request green.
- Dates, numbers and names: an `Intl` formatter or `toLocale…String()` in the web app with no locale, `undefined` or
  `[]` formats in the browser's language and fails the check; one with a locale written in the code (`'en-US'`) warns.
  Use `useFormat()` in components and `fmt()` or `intlLocale()` (`apps/web/src/i18n/format.ts`) elsewhere; a machine
  format on purpose (`en-CA` for ISO dates) gets `// i18n-ignore: <why>`. Reading the browser's time zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) is not formatting.
- Emails and notifications (checked, no baseline): every word of every email, push notification and the pages their
  links open is written in `apps/api/src/emails`, and the whole folder is scanned like the web app; formatting there
  without the reader's locale fails too. Elsewhere on the server (`apps/api/src`, `apps/agent/src`, `packages`) the
  check fails on English handed straight to a sender (`sender.send({ subject: 'Hi', … })`, `sendNotice`,
  `alertInstanceAdmins`), in an object with a text `subject` or with a `title` and a `body`, and in an email's
  `subject`, `preheader`, `heading`, `eyebrow` or `html`. See "Emails and notifications" below.
- Server-side text (checked, ratchet): the same scan over `packages/actions` and `apps/api`. `server-text-baseline.json`
  counts the English still left per file; a file above its count fails, and so does any file it does not list (a new
  one, or one already moved to keys, such as `provider-status.ts` or `phone-input.ts`), which lists each string with
  its line. The baseline is not empty yet and only goes down: `pnpm i18n:check --update-baseline` lowers it after
  strings move to keys, and never raises a count or adds a file. `pnpm i18n:check --server-text` lists every string.
  See "Server-side text" below.

## Server-side text

The shared actions and the API still write English that people read: provider status words, carrier forwarding
steps, field labels, country names, voice pipeline labels, refusals the web app shows, and parts of emails. The plan:

- Actions return a key and params, never a sentence: `{ code: 'provider.keyRejected', params: { provider } }`. The
  web app renders it with `t()` in the reader's language; the setup MCP and the CLI render the same key in English
  with `getT('en')`, so they stay English (the table below) without a second copy of the text.
- Refusals and errors the web app shows (`RefusedError`, API error bodies) carry a code; the web app maps the code to
  a key, as `sign-in-code.ts` does for sign-in errors. The English message stays in the body for logs and API clients.
- Emails: done, and checked (below). The email provider's status lines in Server admin are provider status, with
  the rest.
- Data shipped as content (carrier guides, area codes, sample calls) moves to its own catalog namespace per area,
  translated in the release pass like the rest. What the assistant says stays in the workspace's language
  (`spoken-lines.ts`), not the reader's: that file has every language written out, so the check skips it
  (`SERVER_TEXT_EXCLUDED`).
- Order: what the web app shows most (provider status, carrier steps, field labels, refusals), then emails, then the
  rest. Once an area is done, the check fails on new English there, as it does for the web app.
- How a shared builder does it (`packages/actions/src/words.ts`): it takes `words: Words = english` and writes every
  sentence with `words.t(key, params)` and every list, date or country with `words.format`. The web app passes
  `i18n()`, the API passes `getT(locale)` of the person reading (`localeForUserId`), and the setup MCP and the CLI pass
  nothing, so they get the same keys in English. A label map is `Record<Id, MessageKey>`, never English strings, and
  is read when the screen renders, never at import (a module-level list built from `t()` freezes the first language).
- Refusals and messages the API writes itself: keys in the `server` namespace (`locales/en/server.json`,
  `server.api.*` for this part; the other parts take their own prefix, such as `server.forwardingGuides.*`). The API
  writes them in the caller's language (`wordsOf(actor)`: a member's language in the web app, else Automatic's,
  else the browser's; an API key's request by its `Accept-Language`; the voice agent and the CLI in English):
  - a refusal: `throw Reject.t('server.api.noWorkspace', params)` (or `Forbidden.t`, `NotFound.t`). The answer's
    `error` is in the caller's language, its `code` never changes (clients match the code, not the text), and the
    command log, logs and admin alerts keep the English (`e.message`). A refusal the web app words itself by matching
    its English (`phoneSetupErrorText`, `releaseErrorText`, the forwarding check's internal reasons) stays English
    (`english.t(key)`); one it shows as it is gets a code instead (`FORWARDING_REFUSED`).
  - text stored and read later (a forwarding check's `detail`): the key and params are stored (`said()`), and written
    when it is read, in that reader's language (`detailText`).
  - a provider test (`provider.test`): the result keeps its key (`Tested.said`); the admin who asked reads it in their
    language (`testAnswer`), what is stored, recorded and emailed is English.
  - a param that is words (a list of languages, an amount) is a function of the reader (`SaidParams`), written in the
    same language as the sentence. `said(key, params)` is a key use for `pnpm i18n:check`, like `t()` and `msg()`.
  - the web app never loads `server.json` (its glob leaves it out): only the API writes these texts.
- Done: provider status and health (Server admin › Providers, the overview and the install walkthrough), LiveKit and
  service health, provider and voice failures, phone-number checks and country names, the onboarding business
  templates and install steps; the refusals of `handlers.ts`, Checkout and the forwarding check, the provider
  tests (`provider-test.ts`); invalid action input (`input-errors.ts`, `server.input.*`: a schema's own message is a
  key, `msg('server.input.…')`, with the issue's `params` when it has numbers or names); the refusals of Server admin
  › Billing, appointment types, the team, webhooks, integrations, calendar connections and Write with help; calendar
  listing problems (`calendarProblem`), the partner bill refusals and "not while signed in as another user" in the
  registry; the admin, carrier and billing schema messages. Left, in `server-text-baseline.json`: the providers' setup
  guides and costs (`admin.ts`), carrier forwarding guides, the booking refusals the assistant reads (rule 11) and the rest
  of the API.

## Emails and notifications

Every email, push notification and the page an email's link opens (the setup emails' unsubscribe page) is fully in
the recipient's language, frame and body alike (decided 2026-11-15: an admin alert went out with a Japanese frame and an
English body).

- Write their text only in `apps/api/src/emails`: `templates.ts` (account, team, calls, setup), `alerts.ts` (the alerts
  to every server admin, the spending cap, the setup's test email), `push-text.ts`, `pages.ts`. Keys live in
  `locales/en/email.json`. A feature hands over facts (who, which provider, a time as an ISO string) and the email
  says the rest; never a sentence, a fallback name ("Your workspace", "A server admin") or a formatted date built
  elsewhere.
- Each recipient gets their own language (the table below): an admin alert is a function of the locale
  (`alertInstanceAdmins(alert)`, `AdminAlertText`) that is built once per admin; a job stores data, not text, and the
  email is rendered when it is sent.
- Dates, times and amounts come from `getT(locale).format` (`dateTime`, `currency`, `number`), never `Intl` with a
  written locale or `toISOString()` in a sentence.
- Not translated: what a person, a browser or a provider wrote (names, user agents, addresses, an error message
  quoted as it came), brand names (Chrome, macOS, Telnyx) and codes.
- Test it: `getT('en-XA')` renders the pseudo-locale on the server too; `apps/api/src/emails/alerts.test.ts` checks
  that nothing but data is left outside the ⟦ ⟧. `pnpm --filter @linedesk/api email:preview --locale en-XA`
  renders every email, and `apps/api/src/emails/templates.test.ts` snapshots each one in English and Spanish.

## Which language a reader gets

| Surface | Language |
| --- | --- |
| Web app | The member's choice in Account settings › Preferences, else "Automatic": the browser's languages matched to the ones Linedesk has, else English. Before sign-in: the language last used in this browser |
| Emails about your own account (sign-in code, email change, passkeys, password) | Your choice, else what Automatic last resolved to, else the request's `Accept-Language`, else English |
| Invitations | The workspace's language when Linedesk has it, else the inviter's, else English |
| Notifications to members (new call, assigned call, setup emails, admin alerts) | Each recipient's own. The call summary inside is in the workspace's language, as it is written once per call |
| Booking confirmations to callers | The assistant's main language, else the workspace's, if Linedesk has it, else English |
| What the assistant says, summaries, titles, next steps | The workspace's language (assistant settings), not the member's |
| API errors | The caller's: a member's language in the web app (as above), an API key's request by its `Accept-Language`, else English. Error codes are the same in every language |
| The setup MCP, the CLI, logs, docs | English only |

## Request or add a language

Missing your language? [Ask for it](https://github.com/linedesk/linedesk/issues/new?template=language_request.yml).
Requests collect 👍 votes; the next candidates are Italian, Dutch, Korean, Chinese (Simplified), Polish, Turkish,
Russian and Hindi. Every UI language must also be a voice language, so a business can run its assistant in it.

Adding one (maintainers):

1. Add it to `UI_LOCALES`, `LOCALE_INFO` and `BETA_LOCALES` in `packages/i18n/locales.ts`, and give it a section in
   `STYLE.md` and its words in `glossary.json`.
2. Translate every key for it, as in the release translation pass (`pnpm i18n:translate --locale <locale>` can draft).
3. It shows as "Beta" until a native speaker has reviewed the core flows (above).

Right-to-left languages need a layout pass first (logical CSS properties, mirrored icons); `dir` is already set on
`<html>` from `LOCALE_INFO`.

## Rules for translation pull requests

- No machine-translation dumps from other tools: improve what is there, string by string.
- Keep ICU arguments, tags and plural forms.
- Follow `STYLE.md` and the glossary: product terms (Assistant, Reminder, Needs you, Handled…) use the same word for
  your language everywhere; "never translate" terms (Linedesk, provider names, demo names) stay as they are.
