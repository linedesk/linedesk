import type { InstallSetupState } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import { agentFirstLabels } from './Providers.tsx'

const install = (
  enabled: boolean,
  progress: Partial<InstallSetupState['progress']> = {},
): Pick<InstallSetupState, 'enabled' | 'progress'> => ({
  enabled,
  progress: { step: 'welcome', skipped: [], finishedAt: null, setAsideAt: null, manualBy: [], ...progress },
})

describe('AgentFirst: both ways, also once everything is set up', () => {
  test('not set up: set up with an AI agent, step by step next to it', () => {
    expect(agentFirstLabels(install(true))).toEqual({ agent: 'Set up with an AI agent', steps: 'Step by step' })
    expect(agentFirstLabels(install(true, { step: 'telephony' }))).toEqual({
      agent: 'Set up with an AI agent',
      steps: 'Continue step by step',
    })
  })

  test('everything set up: change with an AI agent, step by step still there (walkthrough finished or not)', () => {
    const changed = { agent: 'Change with an AI agent', steps: 'Step by step' }
    expect(agentFirstLabels(install(true, { step: 'done', finishedAt: '2026-11-01T00:00:00Z' }), true)).toEqual(changed)
    expect(agentFirstLabels(install(true, { step: 'telephony', setAsideAt: '2026-11-01T00:00:00Z' }), true)).toEqual(
      changed,
    )
    expect(agentFirstLabels(install(true), true)).toEqual(changed)
  })

  test('walkthrough off (Cloud) or not read yet: the agent only', () => {
    expect(agentFirstLabels(install(false), true)).toEqual({ agent: 'Change with an AI agent', steps: null })
    expect(agentFirstLabels(undefined)).toEqual({ agent: 'Set up with an AI agent', steps: null })
  })
})
