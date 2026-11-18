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

/**
 * A white-label partner owner's agent setup page (scope "partner"): the partner's steps, then those of `workspaceId`
 * when it is one of its client workspaces (else its first), from GET /v1/partner/agent-setup. The partner's owner only.
 */
export async function loadPartnerAgentSetup(partnerId: string, workspaceId: string | null): Promise<AgentSetupState> {
  const query = new URLSearchParams({ partnerId, ...(workspaceId ? { workspace: workspaceId } : {}) })
  const res = await fetch(`/v1/partner/agent-setup?${query}`, {
    credentials: 'include',
    headers: workspaceHeaders(),
  }).catch(() => null)
  if (!res?.ok) throw new Error(i18n().t('onboarding.agentSetup.error.read'))
  return (await res.json()) as AgentSetupState
}
