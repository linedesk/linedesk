// The words the shared actions hand to people come from the catalogs (packages/i18n), never from English written here
// (docs/translations.md, "Server-side text"). A function that builds text takes `Words`: the web app passes its
// language (i18n()), the API the reader's (getT(locale)), and the setup MCP, the CLI and logs the default, English.
import { createTranslator, type Translator } from '@linedesk/i18n'

export type Words = Pick<Translator, 't' | 'format'>

/** English: the setup MCP, the CLI, logs and API answers ("Which language a reader gets", docs/translations.md). */
export const english: Words = createTranslator('en')
