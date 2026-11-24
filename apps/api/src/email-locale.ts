// Which language an email goes out in (docs/translations.md, "Levels"; DESIGN of LIN-261, "Who gets which language"):
// - about a person's own account: their choice, else what Automatic last resolved to in their browser, else the
//   request's Accept-Language (a sign-in code often has no account behind it yet), else English;
// - an invitation: the workspace's language when the web app has it, else the inviter's, else English;
// - notifications to members: each recipient's own;
// - a booking confirmation to a caller, and a call email to an address outside the team: the language of the call when
//   the web app has it, else English.
import { callLanguageOf } from '@linedesk/actions'
import { assistants, calls, type Tx, user } from '@linedesk/db'
import { isUiLocale, matchLocale, SOURCE, type UiLocale } from '@linedesk/i18n'
import { localeForUser } from '@linedesk/i18n/server'
import { eq, inArray, sql } from 'drizzle-orm'
import { workspaceLocale } from './workspace-locale.ts'

/** A language tag ("de", "pt", "pt-BR", "en-US") as a UI language, or null when the web app does not have it. */
export function uiLocaleOf(tag: string | null | undefined): UiLocale | null {
  if (!tag) return null
  if (isUiLocale(tag)) return tag
  const matched = matchLocale([tag])
  // matchLocale falls back to English: only an English tag counts as English here.
  return matched !== SOURCE || tag.toLowerCase().startsWith('en') ? matched : null
}

/** The language of emails about the account with this address (none yet: the request's languages). */
export async function localeForEmail(tx: Tx, email: string, acceptLanguage?: string | null): Promise<UiLocale> {
  const [row] = await tx
    .select({ locale: user.locale, localeAuto: user.localeAuto })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1)
  return localeForUser(row, acceptLanguage)
}

/** The language of emails to this account. */
export async function localeForUserId(tx: Tx, userId: string): Promise<UiLocale> {
  const [row] = await tx
    .select({ locale: user.locale, localeAuto: user.localeAuto })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return localeForUser(row)
}

/** Each account's email language, by id (notifications go per recipient). */
export async function localesForUserIds(tx: Tx, userIds: string[]): Promise<Map<string, UiLocale>> {
  if (!userIds.length) return new Map()
  const rows = await tx
    .select({ id: user.id, locale: user.locale, localeAuto: user.localeAuto })
    .from(user)
    .where(inArray(user.id, userIds))
  return new Map(rows.map(row => [row.id, localeForUser(row)]))
}

/** An invitation: the workspace's language when the web app has it, else the inviter's, else English. */
export async function invitationLocale(tx: Tx, workspaceId: string, inviterId?: string | null): Promise<UiLocale> {
  const workspace = uiLocaleOf((await workspaceLocale(tx, workspaceId)).resolvedLanguage)
  if (workspace) return workspace
  return inviterId ? localeForUserId(tx, inviterId) : SOURCE
}

/**
 * The language a call is answered in (callLanguageOf: its assistant's main language, else the workspace's), which its
 * title, summary and next steps are written in. Without a call (or one without an assistant): the workspace language.
 */
export async function callLanguage(tx: Tx, workspaceId: string, callId: string | null): Promise<string> {
  const [call] = callId
    ? await tx
        .select({ languages: assistants.languages })
        .from(calls)
        .innerJoin(assistants, eq(assistants.id, calls.assistant_id))
        .where(eq(calls.id, callId))
    : []
  return callLanguageOf(call, (await workspaceLocale(tx, workspaceId)).resolvedLanguage)
}

/**
 * A message to a caller (the booking confirmation), and a call email to an address outside the team, which carries the
 * call's summary: the language the call was answered in (callLanguage); English when the web app does not have it. The
 * call does not store the language the caller switched to, so a caller who switched still gets the main one.
 */
export async function callerLocale(tx: Tx, workspaceId: string, callId: string | null): Promise<UiLocale> {
  return uiLocaleOf(await callLanguage(tx, workspaceId, callId)) ?? SOURCE
}
