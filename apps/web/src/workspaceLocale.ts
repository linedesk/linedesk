// The workspace's country and language in the web app (Workspace settings › General, workspace-locale.ts in
// @linedesk/actions): as set, else worked out by the API (workspace.getSettings). An API of an older version sends
// neither: the US and English, as before.
import { countryNamed } from '@linedesk/actions'
import { useWorkspaceSettings } from './settings/settings-api.ts'

/** The workspace language in use (may be one calls are not answered in: the summaries' language). */
export const useWorkspaceLanguage = (): string | null => useWorkspaceSettings().data?.resolvedLanguage ?? null

/** The country the owner set in Workspace settings › General (not the one worked out); null: automatic or loading. */
export const useExplicitCountry = (): string | null => useWorkspaceSettings().data?.country ?? null

/**
 * The workspace's country in use, and whether something the business did names it (countryNamed: more than a hint or
 * the US fallback); null while the settings load.
 */
export function useWorkspaceCountry(): { country: string; known: boolean } | null {
  const data = useWorkspaceSettings().data
  if (!data?.resolvedCountry) return null
  return { country: data.resolvedCountry, known: !!data.countrySource && countryNamed(data.countrySource) }
}
