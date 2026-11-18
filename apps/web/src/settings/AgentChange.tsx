// "Change with an AI agent" on top of Workspace settings › General and Assistant settings › General (agentChange.ts):
// the notice box modelled on Server admin › Providers (AgentFirst there; the same Note and the same two labels). The
// pages it opens: ChangeWithAgent.tsx and the setup flow, step by step (onboarding/StepByStep.tsx).
import { useT } from '@linedesk/i18n/react'
import { Button, Note } from '../ui/kit.tsx'
import { type ChangeTarget, changeWithAgentHash, stepByStepHash } from './agentChange.ts'

type NoteProps = {
  target: ChangeTarget
  /** The assistant's name, on Assistant settings. */
  assistantName?: string
}

/**
 * The box on top of the settings page: "Change with an AI agent" (secondary: the page's own Save stays the one black
 * button) opens the agent page for this workspace or
 * assistant; "Step by step" opens the setup flow the workspace was set up with, filled in with what is saved. Shown
 * only to those who may change the settings (the page decides, mayChangeWithAgent).
 */
export function AgentChangeNote({ target, assistantName }: NoteProps) {
  const t = useT()
  return (
    <Note
      tone="info"
      action={
        <>
          <Button
            size="sm"
            variant="secondary"
            icon="spark"
            onClick={() => {
              window.location.hash = changeWithAgentHash(target)
            }}
            title={t('settings.agentChange.agentTip')}
          >
            {t('admin.providers.agent.change')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              window.location.hash = stepByStepHash(target)
            }}
            title={t('settings.agentChange.stepsTip')}
          >
            {t('admin.providers.agent.steps')}
          </Button>
        </>
      }
    >
      {target.kind === 'assistant'
        ? t('settings.agentChange.assistant', { name: assistantName ?? '' })
        : t('settings.agentChange.workspace')}
    </Note>
  )
}
