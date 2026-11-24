/**
 * The English catalogs, imported so every key is known to the type checker: `t('inbox.row.markHandled')` with a typo
 * fails `pnpm typecheck`. The first key segment is the namespace (one JSON file), the rest is flat inside the file.
 */
import account from '../locales/en/account.json' with { type: 'json' }
import admin from '../locales/en/admin.json' with { type: 'json' }
import auth from '../locales/en/auth.json' with { type: 'json' }
import call from '../locales/en/call.json' with { type: 'json' }
import common from '../locales/en/common.json' with { type: 'json' }
import contacts from '../locales/en/contacts.json' with { type: 'json' }
import email from '../locales/en/email.json' with { type: 'json' }
import errors from '../locales/en/errors.json' with { type: 'json' }
import inbox from '../locales/en/inbox.json' with { type: 'json' }
import insights from '../locales/en/insights.json' with { type: 'json' }
import onboarding from '../locales/en/onboarding.json' with { type: 'json' }
import server from '../locales/en/server.json' with { type: 'json' }
import settings from '../locales/en/settings.json' with { type: 'json' }
import shell from '../locales/en/shell.json' with { type: 'json' }
import team from '../locales/en/team.json' with { type: 'json' }

type Keys<N extends string, C> = `${N}.${Extract<keyof C, string>}`

/** Every message key the English source defines. */
export type MessageKey =
  | Keys<'account', typeof account>
  | Keys<'admin', typeof admin>
  | Keys<'auth', typeof auth>
  | Keys<'call', typeof call>
  | Keys<'common', typeof common>
  | Keys<'contacts', typeof contacts>
  | Keys<'email', typeof email>
  | Keys<'errors', typeof errors>
  | Keys<'inbox', typeof inbox>
  | Keys<'insights', typeof insights>
  | Keys<'onboarding', typeof onboarding>
  | Keys<'server', typeof server>
  | Keys<'settings', typeof settings>
  | Keys<'shell', typeof shell>
  | Keys<'team', typeof team>

/** The English catalogs by namespace, as the JSON files hold them. */
export const EN_CATALOGS: Record<string, Record<string, string>> = {
  account,
  admin,
  auth,
  call,
  common,
  contacts,
  email,
  errors,
  inbox,
  insights,
  onboarding,
  server,
  settings,
  shell,
  team,
}
