// The two ways to set up or change Workspace settings and Assistant settings, on every section (agentChange.ts): with
// an AI agent or step by step. Until go-live a strip under the context line says they finish the setup
// (AgentSetupStrip, SettingsLayout's `banner`); after it, "Edit with AI" and "Step by step" sit in the top bar
// (AgentChangeActions, `actions`). The agents' marks as on linedesk.ai's hero. The pages they open: ChangeWithAgent.tsx and the setup flow, step by step (onboarding/StepByStep.tsx).
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

/** Owners and admins: `setup` until a real caller reached the assistant (the strip), then `change` (the top bar). */
export type AgentChangeMode = 'setup' | 'change'

const go = (hash: string) => () => {
  window.location.hash = hash
}

/**
 * After go-live, the top bar's "Edit with AI" (secondary: the page's own Save stays the one black button) opens the
 * agent page for this workspace or assistant; "Step by step" opens the setup flow the workspace was set up with, filled
 * in with what is saved. Shown only to those who may change the settings (the page decides, mayChangeWithAgent).
 */
export function AgentChangeActions({ target }: { target: ChangeTarget }) {
  const t = useT()
  return (
    <>
      <Button size="sm" variant="ghost" onClick={go(stepByStepHash(target))} title={t('settings.agentChange.stepsTip')}>
        {t('admin.providers.agent.steps')}
      </Button>
      <AiButton
        label={t('settings.agentChange.edit')}
        title={t('settings.agentChange.agentTip')}
        onClick={go(changeWithAgentHash(target))}
      />
    </>
  )
}

/**
 * Until go-live, a strip under the context line in place of the top bar's buttons: "Finish setting up <name>", what
 * the two ways are, then both (the agent first). The same two pages as AgentChangeActions.
 */
export function AgentSetupStrip({ target, name }: { target: ChangeTarget; name: string }) {
  const t = useT()
  return (
    <section className="as-strip" aria-labelledby="as-strip-title">
      <div className="as-strip-text">
        <h2 id="as-strip-title">{t('settings.agentChange.setupTitle', { name })}</h2>
        <p>{t('settings.agentChange.setupLede')}</p>
      </div>
      <div className="as-strip-actions">
        <AiButton
          label={t('settings.agentChange.withAgent')}
          title={t('settings.agentChange.agentTip')}
          onClick={go(changeWithAgentHash(target))}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={go(stepByStepHash(target))}
          title={t('settings.agentChange.stepsTip')}
        >
          {t('admin.providers.agent.steps')}
        </Button>
      </div>
    </section>
  )
}
