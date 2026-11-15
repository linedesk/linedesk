// The page "Change with an AI agent" opens (#change-with-agent/…, agentChange.ts): the owner's agent setup page
// (onboarding/AgentSetup.tsx, scope "workspace") in "change" mode, never a copy of it.
import { AgentSetup } from '../onboarding/AgentSetup.tsx'
import { useAssistants } from '../store.tsx'
import { type ChangeTarget, settingsHashOf } from './agentChange.ts'

type PageProps = {
  target: ChangeTarget
  workspace: { id: string; name: string }
  account: string
}

/**
 * The agent page in "change" mode: the person's own workspace link, the prompt naming the workspace (and the
 * assistant), "Back to settings" in place of setting up by hand. An assistant that is not (or no longer) in this
 * workspace: the workspace's settings instead.
 */
export function ChangeWithAgent({ target, workspace, account }: PageProps) {
  const assistants = useAssistants()
  const assistant = target.kind === 'assistant' ? assistants.find(a => a.id === target.assistantId) : undefined
  const back = () => {
    window.location.hash = settingsHashOf(target)
  }
  return (
    <AgentSetup
      scope="workspace"
      active={{ id: workspace.id, account }}
      change={{
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        ...(assistant ? { assistant: { id: assistant.id, name: assistant.name } } : {}),
      }}
      onManual={back}
      onDone={back}
    />
  )
}
