// The workspace's country and language as they apply now (workspace-locale.ts in @linedesk/actions): the country the
// owner set in Workspace settings › General, else worked out from the workspace's numbers, holidays and the country hint
// saved when it was made; the language is the country's main language (not a setting). Read by
// workspace.getSettings, call.start (the voice agent's phone region and language) and the setup MCP.
import { resolveWorkspaceLanguage, type WorkspaceCountrySource, workspaceCountryOf } from '@linedesk/actions'
import { assistants, phone_numbers, type Tx, workspace_settings } from '@linedesk/db'
import { asc, eq } from 'drizzle-orm'

export type WorkspaceLocale = {
  /** What the owner set; null: automatic. */
  country: string | null
  /** In use. */
  resolvedCountry: string
  countrySource: WorkspaceCountrySource
  resolvedLanguage: string
}

type SettingsRow = Pick<
  typeof workspace_settings.$inferSelect,
  'country' | 'holidays' | 'country_hint' | 'country_hint_source'
>

/** The workspace's country and language; `settings` when the caller has read its workspace_settings row already. */
export async function workspaceLocale(
  tx: Tx,
  workspaceId: string,
  settings?: SettingsRow | null,
): Promise<WorkspaceLocale> {
  const row =
    settings === undefined
      ? (
          await tx
            .select({
              country: workspace_settings.country,
              holidays: workspace_settings.holidays,
              country_hint: workspace_settings.country_hint,
              country_hint_source: workspace_settings.country_hint_source,
            })
            .from(workspace_settings)
            .where(eq(workspace_settings.workspace_id, workspaceId))
        )[0]
      : settings
  // Only when nothing is set do the numbers count: the common case reads nothing more.
  const explicit = row?.country ?? null
  const numbers = explicit
    ? []
    : await tx
        .select({ e164: phone_numbers.e164 })
        .from(phone_numbers)
        .where(eq(phone_numbers.workspace_id, workspaceId))
        .orderBy(asc(phone_numbers.created_at))
  const [assistant] =
    explicit || numbers.length
      ? []
      : await tx
          .select({ profile: assistants.business_profile })
          .from(assistants)
          .where(eq(assistants.workspace_id, workspaceId))
          .orderBy(asc(assistants.created_at))
          .limit(1)
  const { country, source } = workspaceCountryOf({
    country: explicit,
    assistantNumbers: numbers.map(n => n.e164),
    businessPhone: (assistant?.profile as { phone?: string | null } | undefined)?.phone ?? null,
    holidayCountry: row?.holidays?.country ?? null,
    hint: row ? { country: row.country_hint, source: row.country_hint_source } : null,
  })
  return {
    country: explicit,
    resolvedCountry: country,
    countrySource: source,
    resolvedLanguage: resolveWorkspaceLanguage({ country }),
  }
}
