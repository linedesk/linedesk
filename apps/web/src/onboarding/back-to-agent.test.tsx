// Set up by hand after all (2026-11-18): every step of the step-by-step setup has "Set up with AI" in its top
// bar, for the people the agent setup page is for (setup-choice.ts, `agentSetupWayBack`). The frame shows it in the
// same place on every step, the onboarding passes it on every step but the last, and never when the steps are gone
// through again from the settings (no way back is given there).
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ frame: null as null | Record<string, unknown> }))

vi.mock('../store.tsx', () => ({
  useRun: () => () => {},
  useRows: () => [],
  useRejection: () => ({ rejection: null, clearRejection: () => {} }),
  useAssistantName: () => 'Maya',
}))
// The top bar's account menu (SetupAccountMenu.test.tsx): not about the way back.
vi.mock('../shell/SetupAccountMenu.tsx', () => ({ SetupAccountMenu: () => null }))
// Server admin from the onboarding (#admin…) and the address bar: not about the way back.
vi.mock('../admin/AdminMode.tsx', () => ({ AdminMode: () => null }))
vi.mock('./InstanceSetup.tsx', () => ({
  useHash: () => '',
  isInstanceAdmin: () => false,
  InstanceSetupNotice: () => null,
}))
vi.mock('../settings/settings-api.ts', () => ({
  preloadWorkspaceSettings: async () => {},
  useWriteAction: () => vi.fn(),
}))

const { Frame } = await import('./Frame.tsx')
/** The onboarding's frame, kept for its props (no step renders in it). */
function recordFrame(p: Record<string, unknown>) {
  state.frame = p
  return null
}
type Me = import('../auth.ts').Me

const frame = (p: Partial<ComponentProps<typeof Frame>>) =>
  renderToStaticMarkup(
    <Frame step="business" complete={false} onSkip={() => {}} {...p}>
      <p>step</p>
    </Frame>,
  )

describe('the frame', () => {
  test('shows "Set up with AI" in the top bar, before Finish later', () => {
    const html = frame({ onAgentSetup: () => {} })
    const top = html.slice(html.indexOf('ob-top'), html.indexOf('ob-bar'))
    expect(top).toContain('Set up with AI')
    expect(top).toContain('title="Back to the AI agent setup: what you saved here stays"')
    expect(top.indexOf('Set up with AI')).toBeLessThan(top.indexOf('Finish later'))
  })

  test('without a way back nothing shows', () => {
    expect(frame({})).not.toContain('Set up with AI')
  })

  test('the same place on every step, also the trial card where Finish later is gone', () => {
    for (const step of ['business', 'assistant', 'pickup', 'notify', 'phone'] as const)
      expect(frame({ step, onAgentSetup: () => {} })).toContain('Set up with AI')
    expect(frame({ step: 'activate', onSkip: undefined, onAgentSetup: () => {} })).toContain('Set up with AI')
  })
})

describe('the onboarding', () => {
  beforeEach(async () => {
    state.frame = null
    vi.resetModules()
    vi.doMock('./Frame.tsx', async importOriginal => {
      const real = await importOriginal<typeof import('./Frame.tsx')>()
      return {
        ...real,
        Frame: recordFrame,
      }
    })
  })

  const me = {
    actorId: 'u_1',
    role: 'owner',
    permissions: [],
    impersonation: null,
    workspace: { id: 'ws_1', name: 'Brightwater' },
  } as unknown as Me
  const onboarding = (step: string) =>
    ({ step, phone: { provider: null, available: false, detail: null, canAttach: false } }) as never

  async function render(step: string, onAgentSetup?: () => void) {
    const { Onboarding } = await import('./Onboarding.tsx')
    renderToStaticMarkup(
      <Onboarding
        me={me}
        state={onboarding(step)}
        onDone={() => {}}
        onRenamed={() => {}}
        onAgentSetup={onAgentSetup}
      />,
    )
    return state.frame?.onAgentSetup
  }

  test('passes the way back to every step but the last', async () => {
    const back = () => {}
    for (const step of ['business', 'assistant', 'pickup', 'notify', 'phone'])
      expect(await render(step, back)).toBe(back)
    expect(await render('done', back)).toBeUndefined()
  })

  test('nothing for someone the agent setup is not for', async () => {
    expect(await render('business')).toBeUndefined()
  })
})
