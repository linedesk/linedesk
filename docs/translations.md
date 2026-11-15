# Translations

Linedesk's web app and emails speak English, Español, Português (Brasil), Français, Deutsch and 日本語. English is
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
   catalogs, every key used and defined, no new hardcoded English. Missing translations are fine on `master-dev` and
   staging: the new strings show in English until the next release.
2. Before every release, the release translation pass below translates what is new or changed. Its commit goes to
   `master-dev` like any other change.
3. The release pull request (`master-dev` → `master-prod`) runs `pnpm i18n:check --complete` in its own job,
   `release-translations` (`.github/workflows/ci.yml`): every key in every language present and made from the
   current English. It turns red otherwise and lists each missing or stale key in the log and the run's summary.
   Releases never ship untranslated text; a red release pull request is not merged.

### The release translation pass (required before every release)

Done by the coordinator who releases (or an AI session for them), on `master-dev`, before opening the release pull
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
   theirs), run `pnpm i18n:check --complete` until it passes, and merge the change into `master-dev`.
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
- Other languages: no keys English lacks, the same arguments, tags and plural forms, a lock entry for every key.
- `--complete` (release pull requests only): every key translated and current.
- The ratchet: `hardcoded-baseline.json` counts the user-visible English still in each web app file. A file may only
  go down; a new file starts at 0. After moving strings out, `pnpm i18n:check --update-baseline` writes the new
  counts.

## Which language a reader gets

| Surface | Language |
| --- | --- |
| Web app | The member's choice in Account settings › Preferences, else "Automatic": the browser's languages matched to the ones Linedesk has, else English. Before sign-in: the language last used in this browser |
| Emails about your own account (sign-in code, email change, passkeys, password) | Your choice, else what Automatic last resolved to, else the request's `Accept-Language`, else English |
| Invitations | The workspace's language when Linedesk has it, else the inviter's, else English |
| Notifications to members (new call, assigned call, setup emails, admin alerts) | Each recipient's own. The call summary inside is in the workspace's language, as it is written once per call |
| Booking confirmations to callers | The assistant's main language, else the workspace's, if Linedesk has it, else English |
| What the assistant says, summaries, titles, next steps | The workspace's language (assistant settings), not the member's |
| API errors, the setup MCP, the CLI, logs, docs | English only |

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
