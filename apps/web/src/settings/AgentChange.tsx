// "Edit with AI" in the top bar of Workspace settings and Assistant settings (SettingsLayout's `actions`,
// agentChange.ts), on every section: the agents' marks as on linedesk.ai's hero, then the label. Next to it "Step by
// step". The pages they open: ChangeWithAgent.tsx and the setup flow, step by step (onboarding/StepByStep.tsx).
// Server admin › Providers (admin/Providers.tsx, AgentFirst) uses the same AiButton, in the same order.
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
 * The AI button wherever an agent can set up or change something (settings top bar, Server admin › Providers, the setup
 * pages' top bar, the admin start page): the agents' marks, then the label. `size` "md" where it is a page's main action.
 */
export function AiButton({
  label,
  title,
  onClick,
  size = 'sm',
  className,
}: {
  label: string
  title: string
  onClick: () => void
  size?: 'sm' | 'md'
  className?: string
}) {
  const cls = ['k-btn', 'k-btn-secondary', size === 'sm' && 'k-btn-sm', 'ai-edit', className].filter(Boolean).join(' ')
  return (
    <button type="button" className={cls} onClick={onClick} title={title} aria-label={label}>
      <AgentMarks />
      <span className="ai-label">{label}</span>
    </button>
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
      <AiButton
        label={t('settings.agentChange.edit')}
        title={t('settings.agentChange.agentTip')}
        onClick={() => {
          window.location.hash = changeWithAgentHash(target)
        }}
      />
    </>
  )
}
