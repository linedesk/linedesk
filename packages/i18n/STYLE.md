# Translation style

Read by people and by the translate script (`scripts/translate.ts` sends the general part and the language's own
section with every request). English is the source; Linedesk is a US product, so the English text is the reference
for meaning and tone.

## General

- Plain and short, like the English. A button stays a verb or two; a label stays a noun. Prefer the wording people
  already know from common apps in that language over a literal translation.
- No exclamation marks the English doesn't have. No added politeness phrases, no emojis.
- Sentence case for buttons, titles and labels, unless the language capitalizes nouns (German).
- Keep ICU arguments (`{name}`, `{count}`), tags (`<b>…</b>`) and `#` exactly as they are. Never translate argument
  or tag names. Plurals: give every plural category the language has (`one`/`other` for most, `other` only for
  Japanese, `one`/`many`/`other` for French, Spanish and Portuguese where CLDR asks for it).
- Dates, times, numbers and amounts are never written into a message; they come in as arguments already formatted.
- Keyboard keys (`E`, `Esc`, `⌘K`) and code (`{brand}`, URLs, file names) stay untranslated.
- Terms: follow `glossary.json`. "Never translate" terms stay as they are (Linedesk, brand names, demo names). Product
  terms use the fixed word for the language every time (Assistant, never "receptionist"; Reminder, never "snooze").
- Sample calls (`server.sample.*`): the example calls a new workspace can fill its inbox with. Write them as such a
  call sounds in that language's main country: local first and last names for the callers (the email address in
  `server.sample.quote.email` matching the caller's name, at `example.com`), everyday wording, nothing tied to one trade.
- `_context.json` notes say where a string appears and how long it may be. Keep to the limit.

## es: Spanish

- Neutral Latin-American and US Spanish: no vosotros, no Spain-only words (ordenador, móvil, vale). `tú`.
- "Llamada" for call, "quien llama" for the caller in running text.

## pt-BR: Portuguese (Brazil)

- Brazilian Portuguese, `você`. "Chamada" for call; "ligar" for the verb.
- Avoid European Portuguese forms (ecrã, telemóvel, utilizador): use tela, celular, usuário.

## fr: French

- `vous`. A space before `:` `;` `?` `!` as French typography expects (a non-breaking one, U+00A0, so it never
  wraps).
- "Appel" for call, "appelant" for the caller. "Rappel" is the Reminder; "rappeler" (to call back) only where the
  English says call back.

## de: German

- `du` (the norm for modern SaaS), lowercase `dein`/`du` inside sentences.
- Nouns capitalized as German requires. Keep compounds readable; split very long ones with a hyphen.
- "Anruf" for call, "Anrufer" for the caller.

## ja: Japanese

- Polite UI style: です/ます in sentences, plain noun phrases for buttons and labels (保存, 削除, キャンセル).
- No katakana for words with a common kanji term (設定, not セッティング; 通話, not コール).
- No spaces between Japanese and numbers or arguments unless the English needs a word break; full-width punctuation
  （、。）in sentences.
