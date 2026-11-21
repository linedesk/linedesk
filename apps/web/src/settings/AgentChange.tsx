// "Edit with AI" in the top bar of Workspace settings and Assistant settings (SettingsLayout's `actions`,
// agentChange.ts), on every section: the agents' marks as on linedesk.ai's hero, then the label. Next to it "Step by
// step". The pages they open: ChangeWithAgent.tsx and the setup flow, step by step (onboarding/StepByStep.tsx).
import { useT } from '@linedesk/i18n/react'
import { CLAUDE, CLAUDE_ORANGE, CURSOR, GEMINI, GEMINI_PURPLE, OPENAI } from '../onboarding/AgentPicker.tsx'
import { Button } from '../ui/kit.tsx'
import './agent-change.css'
import { type ChangeTarget, changeWithAgentHash, stepByStepHash } from './agentChange.ts'

/** The marks in the button, each white on its brand's colour (the order and colours of linedesk.ai's hero). */
const MARKS = [
  { d: OPENAI, bg: '#0F0F0F' },
  { d: GEMINI, bg: GEMINI_PURPLE },
  { d: CURSOR, bg: '#26251E' },
  { d: CLAUDE, bg: CLAUDE_ORANGE },
] as const

function AgentMarks() {
  return (
    <span className="ai-marks" aria-hidden="true">
      {MARKS.map(m => (
        <span key={m.bg} className="ai-mark" style={{ background: m.bg }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d={m.d} />
          </svg>
        </span>
      ))}
    </span>
  )
}

/**
 * The top bar's "Edit with AI" (secondary: the page's own Save stays the one black button) opens the agent page for
 * this workspace or assistant; "Step by step" opens the setup flow the workspace was set up with, filled in with what
 * is saved. Shown only to those who may change the settings (the page decides, mayChangeWithAgent).
 */
export function AgentChangeActions({ target }: { target: ChangeTarget }) {
  const t = useT()
  return (
    <>
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
      <button
        type="button"
        className="k-btn k-btn-secondary k-btn-sm ai-edit"
        onClick={() => {
          window.location.hash = changeWithAgentHash(target)
        }}
        title={t('settings.agentChange.agentTip')}
      >
        <AgentMarks />
        <span>{t('settings.agentChange.edit')}</span>
      </button>
    </>
  )
}
