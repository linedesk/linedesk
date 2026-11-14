// Workspace settings › General without React: the checks behind the business name field.
import { workspaceNameProblem } from '@linedesk/actions'

/**
 * What the business name field would save: the trimmed name, whether it differs from the saved one, and why it
 * can't be saved (the workspaceName schema of workspace.rename), or null. An unchanged name is never a problem.
 */
export function renameCheck(draft: string, saved: string): { next: string; changed: boolean; problem: string | null } {
  const next = draft.trim()
  const changed = next !== saved
  return { next, changed, problem: changed ? workspaceNameProblem(next) : null }
}
