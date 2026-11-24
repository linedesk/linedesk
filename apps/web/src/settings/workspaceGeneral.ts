// Workspace settings › General without React: the checks behind the business name field.
import { workspaceNameProblem } from '@linedesk/actions'
import { i18n } from '../i18n/index.tsx'

/**
 * What the business name field would save: the trimmed name, whether it differs from the saved one, and why it
 * can't be saved (the workspaceName schema of workspace.rename), or null. An unchanged name is never a problem.
 */
export function renameCheck(draft: string, saved: string): { next: string; changed: boolean; problem: string | null } {
  const next = draft.trim()
  const changed = next !== saved
  return { next, changed, problem: changed ? workspaceNameProblem(next, i18n()) : null }
}

type RenameSteps = {
  /** Sends workspace.rename and resolves once the server saved it (useWriteAction). */
  write: (name: string) => Promise<unknown>
  /** Saved: the menu, the page and the field take the new name. */
  saved: (name: string) => void
  /** Refused or not sent: the field shows the saved name again, `reason` says why. */
  refused: (reason: string) => void
}

/**
 * Renames the workspace: the new name shows outside the field only once the server has saved it, so a refusal (support
 * access, a lost connection) never leaves a name on screen that is not the workspace's.
 */
export async function saveRename(next: string, steps: RenameSteps): Promise<void> {
  try {
    await steps.write(next)
  } catch (e) {
    steps.refused(e instanceof Error ? e.message : String(e))
    return
  }
  steps.saved(next)
}
