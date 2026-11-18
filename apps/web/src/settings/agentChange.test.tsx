// "Change with an AI agent" on Workspace settings › General and Assistant settings › General (agentChange.ts,
// AgentChange.tsx): offered to owners and admins only, the box on top of the form, the address of the page it opens
// and the way back; and "Finish later" on the owner's agent setup page (onboarding/AgentSetup.tsx).
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
  refreshWorkspaceSettings: vi.fn(),
  callAction: vi.fn(),
  useWriteAction: () => vi.fn(),
}))
vi.mock('../store.tsx', () => ({ useRun: () => vi.fn(), useRows: () => [], useAssistants: () => [] }))
vi.mock('../shell/WorkspaceSwitcher.tsx', () => ({ useWorkspaces: () => [] }))
// The top bar's account menu (SetupAccountMenu.test.tsx): not about these pages.
vi.mock('../shell/SetupAccountMenu.tsx', () => ({ SetupAccountMenu: () => null }))

const { changeWithAgentHash, mayChangeWithAgent, parseChangeWithAgent, settingsHashOf } = await import(
  './agentChange.ts'
)
const { AgentChangeNote } = await import('./AgentChange.tsx')
const { WorkspaceGeneral } = await import('./WorkspaceGeneral.tsx')
const { AgentSetup } = await import('../onboarding/AgentSetup.tsx')

const ADMIN_PERMISSIONS = ['calls:read', 'settings:write', 'team:manage']
type Who = Parameters<typeof mayChangeWithAgent>[0]
const me = (role: string, extra: Partial<Who> = {}): Who => ({
  role,
  permissions: role === 'member' ? ['calls:read'] : ADMIN_PERMISSIONS,
  impersonation: null,
  workspace: { id: 'ws1', name: 'Brightwater', disabled: false },
  ...extra,
})

describe('who is offered the agent', () => {
  test('owners and admins: they change the settings themselves, so their agent may too', () => {
    expect(mayChangeWithAgent(me('owner'))).toBe(true)
    expect(mayChangeWithAgent(me('admin'))).toBe(true)
  })

  test('members see nothing of it', () => {
    expect(mayChangeWithAgent(me('member'))).toBe(false)
    // A role name alone is not enough: the permission to change settings is.
    expect(mayChangeWithAgent(me('admin', { permissions: ['calls:read'] }))).toBe(false)
  })

  test('never while a server admin is signed in as someone, without a confirmed address, or in a disabled workspace', () => {
    expect(mayChangeWithAgent(me('owner', { impersonation: { adminEmail: 'ops@example.com' } } as never))).toBe(false)
    expect(mayChangeWithAgent(me('owner', { emailUnconfirmed: true } as never))).toBe(false)
    expect(
      mayChangeWithAgent(me('admin', { workspace: { id: 'ws1', name: 'Brightwater', disabled: true } } as never)),
    ).toBe(false)
  })
})

describe('the page address', () => {
  test('a workspace or an assistant, and back to the settings page it came from', () => {
    const ws = { kind: 'workspace' } as const
    const assistant = { kind: 'assistant', assistantId: 'a 1' } as const
    expect(changeWithAgentHash(ws)).toBe('#change-with-agent/workspace')
    expect(parseChangeWithAgent(changeWithAgentHash(ws))).toEqual(ws)
    expect(parseChangeWithAgent(changeWithAgentHash(assistant))).toEqual(assistant)
    expect(settingsHashOf(ws)).toBe('#workspace/general')
    expect(settingsHashOf(assistant)).toBe('#assistant/a 1/general')
  })

  test('anything else is not the page', () => {
    for (const hash of ['', '#workspace', '#change-with-agent', '#change-with-agent/', '#change-with-agent/team'])
      expect(parseChangeWithAgent(hash)).toBeNull()
    expect(parseChangeWithAgent('#change-with-agent/assistant/')).toBeNull()
    expect(parseChangeWithAgent('#change-with-agent/assistant/a1/more')).toBeNull()
    expect(parseChangeWithAgent('#change-with-agent/workspace/x')).toBeNull()
  })
})

describe('the box on top of the settings', () => {
  // From the box to the first field below it.
  const box = (html: string) => html.slice(html.indexOf('k-note-info'), html.indexOf('id="ws-name"'))

  test('Workspace settings › General: the box first, with the agent as the main way and step by step beside it', () => {
    const html = renderToStaticMarkup(
      <WorkspaceGeneral canEdit agentChange name="Brightwater" onRenamed={() => {}} toast={() => {}} />,
    )
    const note = box(html)
    expect(note).toContain('An AI agent can change these settings with you.')
    expect(note).toMatch(/k-btn-primary[^>]*>.*Change with an AI agent/)
    expect(note).toContain('Step by step')
    // Above the form: before the business name.
    expect(html.indexOf('k-note-info')).toBeLessThan(html.indexOf('id="ws-name"'))
  })

  test('no box where the page says no (members, and everyone else mayChangeWithAgent turns away)', () => {
    for (const canEdit of [true, false]) {
      const html = renderToStaticMarkup(
        <WorkspaceGeneral canEdit={canEdit} name="Brightwater" onRenamed={() => {}} toast={() => {}} />,
      )
      expect(html).not.toContain('Change with an AI agent')
    }
  })

  test('Assistant settings: the box names the assistant', () => {
    const html = renderToStaticMarkup(
      <AgentChangeNote target={{ kind: 'assistant', assistantId: 'a1' }} assistantName="Ava" />,
    )
    expect(html).toContain('An AI agent can change Ava’s settings with you.')
    expect(html).toContain('Change with an AI agent')
    expect(html).toContain('Step by step')
  })
})

describe('the owner’s agent setup page: finish later', () => {
  const page = (onLater?: () => void) =>
    renderToStaticMarkup(
      <AgentSetup
        scope="workspace"
        active={{ id: 'ws1', account: 'u1' }}
        onManual={() => {}}
        onDone={() => {}}
        onLater={onLater}
      />,
    )

  test('while the onboarding is open: "Finish later" in the top bar, as in the business onboarding', () => {
    const html = page(() => {})
    const top = html.match(/<div class="ob-top">[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(top).toMatch(
      /title="Finish setup later[^"]*\(Shift\+Esc\)" class="[^"]*k-btn-ghost[^"]*"><span>Finish later</,
    )
  })

  test('opened again after the onboarding (or to change settings): no "Finish later"', () => {
    expect(page()).not.toContain('Finish later')
  })
})
