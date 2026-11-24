// The install's own steps. The setup pages have no passkey step: they are part of Server admin and open only after
// the passkey check (SecondFactorPrompt.tsx).
import { type InstallProgress, installParts } from '@linedesk/actions'

/**
 * Whether the way by hand starts with the install walkthrough: a server part (installParts) is not set up and was not
 * handled there yet. A part counts as handled once the walkthrough skipped it, was set aside ("Finish later") or
 * finished: what is left then waits in Server admin › Providers, and by hand goes on to naming the business (never
 * the walkthrough's Done again, which led back here).
 */
export function installPartsMissing(
  steps: readonly { id: string; state: string }[],
  progress?: Pick<InstallProgress, 'skipped' | 'setAsideAt' | 'finishedAt'> | null,
): boolean {
  if (progress?.finishedAt || progress?.setAsideAt) return false
  const skipped: readonly string[] = progress?.skipped ?? []
  return steps.some(
    s => (installParts as readonly string[]).includes(s.id) && s.state !== 'done' && !skipped.includes(s.id),
  )
}
