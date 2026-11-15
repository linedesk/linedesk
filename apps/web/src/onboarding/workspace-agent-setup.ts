// A workspace owner's agent setup page (AgentSetup.tsx, scope "workspace"): its state from GET
// /v1/workspace/agent-setup, for this tab's workspace. Owners only; the server answers 403 to anyone else.
import type { AgentSetupState } from '@linedesk/actions'
import { i18n } from '../i18n/index.tsx'
import { workspaceHeaders } from '../tabWorkspace.ts'

export async function loadWorkspaceAgentSetup(): Promise<AgentSetupState> {
  const res = await fetch('/v1/workspace/agent-setup', { credentials: 'include', headers: workspaceHeaders() }).catch(
    () => null,
  )
  if (!res?.ok) throw new Error(i18n().t('onboarding.agentSetup.error.read'))
  return (await res.json()) as AgentSetupState
}
