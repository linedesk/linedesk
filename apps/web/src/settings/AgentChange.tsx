// "Change with an AI agent" on top of Workspace settings › General and Assistant settings › General (agentChange.ts):
// the notice box modelled on Server admin › Providers (AgentFirst there; the same Note and the same two labels). The
// page it opens: ChangeWithAgent.tsx.
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { Button, Note } from '../ui/kit.tsx'
import { type ChangeTarget, changeWithAgentHash } from './agentChange.ts'

type NoteProps = {
  target: ChangeTarget
  /** The assistant's name, on Assistant settings. */
  assistantName?: string
  /** The field "Step by step" puts the cursor in: the form right below the box. */
  firstField: string
}

/**
 * The box on top of the settings page: "Change with an AI agent" (primary) opens the agent page for this workspace or
 * assistant; "Step by step" closes the box for this visit and puts the cursor in the form below it. Shown only to
 * those who may change the settings (the page decides, mayChangeWithAgent).
 */
export function AgentChangeNote({ target, assistantName, firstField }: NoteProps) {
  const t = useT()
  const [closed, setClosed] = useState(false)
  if (closed) return null
  const stepByStep = () => {
    setClosed(true)
    setTimeout(() => document.getElementById(firstField)?.focus(), 0)
  }
  return (
    <Note
      tone="info"
      action={
        <>
          <Button
            size="sm"
            variant="primary"
            icon="spark"
            onClick={() => {
              window.location.hash = changeWithAgentHash(target)
            }}
            title={t('settings.agentChange.agentTip')}
          >
            {t('admin.providers.agent.change')}
          </Button>
          <Button size="sm" variant="ghost" onClick={stepByStep} title={t('settings.agentChange.stepsTip')}>
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
