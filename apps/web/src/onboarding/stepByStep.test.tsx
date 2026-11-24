// "Step by step" on Workspace and Assistant settings › General (StepByStep.tsx): the onboarding's steps again, with
// what is saved. Which steps (the number and the end screen are left out), the address and who may open it, the frame
// in edit mode (Close, Done, one primary button), the steps filled in from the saved rows, a save going to the
// assistant the settings were opened for, and where Continue and Back lead (back to the settings at either end).
import type { Assistant } from '@linedesk/db/types'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  assistants: [] as unknown[],
  run: (() => {}) as (name: string, input: unknown) => void,
  /** The Continue of the last Foot rendered (the step's own save, then onNext). */
  continue: null as null | (() => void),
}))

vi.mock('../store.tsx', () => ({
  useAssistants: () => state.assistants,
  useAssistantOf: (id: string | undefined) =>
    id === undefined ? state.assistants[0] : state.assistants.find(a => (a as Assistant).id === id),
  useAssistantName: () => (state.assistants[0] as Assistant | undefined)?.name ?? 'Assistant',
  useRun: () => state.run,
  // A connected number: the workspace is live enough that the number is no step of its own here.
  useRows: (table: string) => (table === 'phone_numbers' ? [{ id: 'num_1', e164: '+15035550142' }] : []),
  useRejection: () => ({ rejection: null, clearRejection: () => {} }),
}))
vi.mock('../settings/settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null, error: null, reload: async () => {} }),
  preloadWorkspaceSettings: async () => {},
  patchWorkspaceSettings: () => {},
  callAction: vi.fn(),
  useWriteAction: () => vi.fn(),
}))
vi.mock('../inbox/GoLiveChecklist.tsx', () => ({ useGoLiveChecklist: () => undefined }))
vi.mock('../phoneCountry.ts', () => ({ useDefaultPhoneCountry: () => 'US' }))
vi.mock('../workspaceLocale.ts', () => ({
  useWorkspaceLanguage: () => 'en',
  useWorkspaceCountry: () => ({ country: 'US', known: true }),
}))
vi.mock('../settings/TestCall.tsx', () => ({
  useTestCall: () => ({ blockedReason: null, start: () => {} }),
  TestCallButton: ({ variant = 'secondary' }: { variant?: string }) => (
    <button type="button" className={`test-call-${variant}`} />
  ),
}))
vi.mock('../settings/TestCallPanel.tsx', () => ({ TestCallPanel: () => null }))
vi.mock('../settings/VoiceSettings.tsx', () => ({
  useVoiceOptions: () => ({ data: null }),
  VoiceSettings: () => null,
  RealtimeVoiceSettings: () => null,
  VoiceLoading: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../shell/useCallNotifications.ts', () => ({
  useNotificationQuery: () => ({ data: null }),
  setNotificationSettings: () => {},
}))
vi.mock('../settings/Notifications.tsx', () => ({ useDeviceNotifications: () => ({}) }))
vi.mock('../team/members.ts', () => ({ useMember: () => ({ name: 'Mike Brennan' }) }))
vi.mock('./outbound-number.ts', () => ({
  useOutboundCountries: () => null,
  withUnfinishedNumber: (_d: unknown, p: unknown) => p,
}))
// The account menu in the top bar (SetupTopBar), drawn on its own in SetupAccountMenu.test.tsx.
vi.mock('../shell/SetupAccountMenu.tsx', () => ({ SetupAccountMenu: () => <span className="ob-me" /> }))
vi.mock('./Frame.tsx', async importOriginal => {
  const real = await importOriginal<typeof import('./Frame.tsx')>()
  return {
    ...real,
    Foot: (p: Parameters<typeof real.Foot>[0]) => {
      state.continue = p.onContinue ?? null
      return real.Foot(p)
    },
  }
})

const { firstOpenStep, stepByStepMove, stepByStepSteps } = await import('./flow.ts')
const { mayStepThrough, parseStepByStep, stepByStepHash } = await import('../settings/agentChange.ts')
const { StepByStep } = await import('./StepByStep.tsx')
const { StepScreen, useStepSaves } = await import('./Onboarding.tsx')
const { Frame } = await import('./Frame.tsx')
type Me = import('../auth.ts').Me

const maya = {
  id: 'as_maya',
  name: 'Maya',
  greeting: 'Thanks for calling Brightwater Plumbing & Heating. This is Maya. How can I help?',
  languages: { main: 'en' },
  voice: {},
  transfers: [],
  business_profile: {
    instructions: 'Common calls:\n- Leaking pipes',
    website: 'brightwater-plumbing.example',
    phone: '+15035550142',
    description: 'Plumbing and heating in Portland',
  },
  created_at: '2026-11-01T00:00:00Z',
} as unknown as Assistant
const ava = {
  ...maya,
  id: 'as_ava',
  name: 'Ava',
  greeting: 'Hi, this is Ava at Brightwater.',
  created_at: '2026-11-02T00:00:00Z',
} as unknown as Assistant

const me = {
  actorId: 'u1',
  role: 'owner',
  permissions: ['calls:read', 'settings:write', 'team:manage'],
  impersonation: null,
  workspace: { id: 'ws1', name: 'Brightwater Plumbing & Heating', disabled: false },
  onboarding: null,
  phoneSetup: null,
  businessSetup: { businessLookup: true, websiteImport: 'on' },
} as unknown as Me

beforeEach(() => {
  state.assistants = [maya, ava]
  state.run = () => {}
  state.continue = null
})

describe('which steps are gone through again', () => {
  test('the workspace: the onboarding without the number and the end screen', () => {
    expect(stepByStepSteps('workspace', false)).toEqual(['business', 'assistant', 'pickup', 'notify'])
  })

  test('the number only when the pick-up choice just changed how a connected number forwards (a new code to dial)', () => {
    expect(stepByStepSteps('workspace', true)).toEqual(['business', 'assistant', 'pickup', 'notify', 'phone'])
  })

  test('one assistant: what is about it, not the workspace’s pick-up choice', () => {
    expect(stepByStepSteps('assistant', false)).toEqual(['business', 'assistant', 'notify'])
    expect(stepByStepSteps('assistant', true)).toEqual(['business', 'assistant', 'notify'])
    expect(stepByStepSteps('assistant', false, true)).toEqual(['business', 'assistant', 'notify'])
  })

  test('the number too while the workspace is not live yet (no number, forwarding not verified)', () => {
    expect(stepByStepSteps('workspace', false, true)).toEqual(['business', 'assistant', 'pickup', 'notify', 'phone'])
  })

  test('opens at the first step still open, else the first one', () => {
    const steps = stepByStepSteps('workspace', false, true)
    expect(firstOpenStep(steps, { business: false, pickup: true, phone: true })).toBe('pickup')
    expect(firstOpenStep(steps, { phone: true })).toBe('phone')
    expect(firstOpenStep(steps, {})).toBe('business')
  })
})

describe('Continue and Back', () => {
  const steps = stepByStepSteps('workspace', false)
  test('the next and the previous step', () => {
    expect(stepByStepMove(steps, 'business', 'next')).toBe('assistant')
    expect(stepByStepMove(steps, 'notify', 'back')).toBe('pickup')
  })

  test('Done on the last step and Back on the first go back to the settings', () => {
    expect(stepByStepMove(steps, 'notify', 'next')).toBe('close')
    expect(stepByStepMove(steps, 'business', 'back')).toBe('close')
  })
})

describe('the address and who may open it', () => {
  test('a workspace or an assistant', () => {
    const ws = { kind: 'workspace' } as const
    const assistant = { kind: 'assistant', assistantId: 'as 1' } as const
    expect(stepByStepHash(ws)).toBe('#step-by-step/workspace')
    expect(parseStepByStep(stepByStepHash(ws))).toEqual(ws)
    expect(parseStepByStep(stepByStepHash(assistant))).toEqual(assistant)
    for (const hash of ['', '#step-by-step', '#step-by-step/team', '#change-with-agent/workspace'])
      expect(parseStepByStep(hash)).toBeNull()
  })

  test('owners and admins in their own session, in a workspace that is not disabled', () => {
    expect(mayStepThrough(me)).toBe(true)
    expect(mayStepThrough({ ...me, permissions: ['calls:read'] })).toBe(false)
    expect(mayStepThrough({ ...me, impersonation: { adminEmail: 'ops@example.com' } } as never)).toBe(false)
    expect(mayStepThrough({ ...me, workspace: { ...me.workspace!, disabled: true } })).toBe(false)
  })
})

describe('the workspace’s steps, from Workspace settings', () => {
  const render = () => renderToStaticMarkup(<StepByStep target={{ kind: 'workspace' }} me={me} onRenamed={() => {}} />)

  test('the first step in the onboarding’s frame: its count, Close in place of Finish later', () => {
    const html = render()
    expect(html).toContain('Step 1 of 4 · Your business')
    expect(html).toMatch(/title="Back to settings[^"]*\(Shift\+Esc\)"[^>]*><span>Close</)
    expect(html).not.toContain('Finish later')
    // The account menu, as on every setup page (2026-11-18).
    expect(html).toContain('class="ob-me"')
  })

  test('the business details as saved, to look over and change', () => {
    const html = render()
    expect(html).toMatch(/id="ob-biz-name"[^>]*value="Brightwater Plumbing &amp; Heating"/)
    // The website given before shows as set, like the country, with Change to edit it.
    expect(html).toMatch(/<span id="ob-biz-web">brightwater-plumbing.example<\/span>/)
    expect(html).toContain('Plumbing and heating in Portland')
    // One primary button: Continue.
    expect(html.match(/k-btn-primary/g)).toHaveLength(1)
  })
})

/** A step as StepByStep shows it, without moving there by hand first. */
function Step({
  step,
  steps,
}: {
  step: 'business' | 'assistant' | 'notify'
  steps: ('business' | 'assistant' | 'notify')[]
}) {
  const saves = useStepSaves()
  return (
    <Frame step={step} complete steps={steps} edit onSkip={() => {}}>
      <StepScreen
        step={step}
        me={me}
        emailConfirmed
        phone={{ provider: null, available: false, detail: null, canAttach: false }}
        businessLookup
        assistantId="as_ava"
        saves={saves}
        pickupMemory={{ hoursOnBefore: null, oldForwarding: null }}
        onPickupMemory={() => {}}
        onRenamed={() => {}}
        onBack={() => {}}
        onNext={() => {}}
      />
    </Frame>
  )
}

describe('one assistant’s steps, from its settings', () => {
  const steps = stepByStepSteps('assistant', false) as ('business' | 'assistant' | 'notify')[]
  const html = (step: 'business' | 'assistant' | 'notify') => renderToStaticMarkup(<Step step={step} steps={steps} />)

  test('“Meet your assistant” with this assistant’s name and greeting, not the default one’s', () => {
    const page = html('assistant')
    expect(page).toContain('Step 2 of 3')
    expect(page).toMatch(/id="ob-name"[^>]*value="Ava"/)
    expect(page).toContain('Hi, this is Ava at Brightwater.')
    expect(page).not.toMatch(/value="Maya"/)
    // The test call stands beside Continue: one primary button on the screen.
    expect(page).toContain('test-call-secondary')
    expect(page.match(/k-btn-primary/g)).toHaveLength(1)
  })

  test('the last step: Done in place of Continue, and nothing put off for “Later”', () => {
    const page = html('notify')
    expect(page).toContain('Step 3 of 3')
    expect(page).toMatch(/k-btn-primary[^>]*>(<[^>]*>)*Done</)
    expect(page).not.toMatch(/>Later</)
  })

  test('saving the business step saves this assistant’s profile, with the same action as its settings', () => {
    const saved: { name: string; input: { assistantId?: string; business_profile?: { website?: string } } }[] = []
    state.run = (name, input) => void saved.push({ name, input: input as never })
    html('business')
    expect(state.continue).toBeTypeOf('function')
    state.continue!()
    const update = saved.find(s => s.name === 'assistant.update')
    expect(update?.input.assistantId).toBe('as_ava')
    expect(update?.input.business_profile?.website).toBe('brightwater-plumbing.example')
    // The onboarding is not moved: nothing here sets its step.
    expect(saved.some(s => s.name.startsWith('onboarding.'))).toBe(false)
  })
})
