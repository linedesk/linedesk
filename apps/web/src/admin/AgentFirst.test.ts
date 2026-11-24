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
  test('not set up: set up with AI, step by step next to it', () => {
    expect(agentFirstLabels(install(true))).toEqual({
      agent: 'Set up with AI',
      steps: 'Step by step',
      stepsFrom: 'start',
    })
    expect(agentFirstLabels(install(true, { step: 'telephony' }))).toEqual({
      agent: 'Set up with AI',
      steps: 'Continue step by step',
      stepsFrom: 'left',
    })
  })

  test('everything set up: edit with AI, step by step still there (walkthrough finished or not)', () => {
    const changed = { agent: 'Edit with AI', steps: 'Step by step', stepsFrom: 'start' }
    expect(agentFirstLabels(install(true, { step: 'done', finishedAt: '2026-11-01T00:00:00Z' }), true)).toEqual(changed)
    expect(agentFirstLabels(install(true, { step: 'telephony', setAsideAt: '2026-11-01T00:00:00Z' }), true)).toEqual(
      changed,
    )
    expect(agentFirstLabels(install(true), true)).toEqual(changed)
  })

  test('walkthrough off (Cloud) or not read yet: the agent only', () => {
    expect(agentFirstLabels(install(false), true)).toMatchObject({ agent: 'Edit with AI', steps: null })
    expect(agentFirstLabels(undefined)).toMatchObject({ agent: 'Set up with AI', steps: null })
  })
})

describe('AgentFirst: only "Continue step by step" resumes', () => {
  test('a started walkthrough continues where it was left; once everything is set up it starts at the first part', () => {
    const started = install(true, { step: 'call-audio' })
    expect(agentFirstLabels(started)).toMatchObject({ steps: 'Continue step by step', stepsFrom: 'left' })
    expect(agentFirstLabels(started, true)).toMatchObject({ steps: 'Step by step', stepsFrom: 'start' })
  })

  test('a finished walkthrough starts at the first part, set up or not', () => {
    const finished = install(true, { step: 'done', finishedAt: '2026-11-01T00:00:00Z' })
    expect(agentFirstLabels(finished)).toMatchObject({ steps: 'Step by step', stepsFrom: 'start' })
    expect(agentFirstLabels(finished, true)).toMatchObject({ steps: 'Step by step', stepsFrom: 'start' })
  })
})
