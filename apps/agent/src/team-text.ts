// The fixed texts the agent files for the team (titles, summaries and next steps written without the language model),
// in the workspace language like the generated summaries (docs/translations.md, "Which language a reader gets"). They
// are written once per call and also go out in emails, webhooks and exports, so they are rendered here, not in the
// reader's language. A workspace language the web app has no catalog for gets English.
import { matchLocale } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'

/** `t()` in the team's language ("es", "pt", "de-AT"): the closest UI language, else English. */
export const teamT = (language: string | null | undefined) => getT(language ? matchLocale([language]) : 'en').t
