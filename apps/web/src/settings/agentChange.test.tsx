// The strip to finish the setup on Workspace settings and Assistant settings until go-live (agentChange.ts, AgentChange.tsx):
// offered to owners and admins only, the buttons with the agents' marks, the address of the page it opens
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
const { AgentSetupStrip } = await import('./AgentChange.tsx')
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

describe('until go-live: the strip to finish the setup', () => {
  test('names what it sets up and offers both ways, the agent first', () => {
    const html = renderToStaticMarkup(<AgentSetupStrip target={{ kind: 'assistant', assistantId: 'a1' }} name="Maya" />)
    expect(html).toContain('Finish setting up Maya')
    expect(html).toContain('Let your AI agent do it, or go through the steps yourself.')
    expect(html.indexOf('With your AI agent')).toBeLessThan(html.indexOf('Step by step'))
    expect(html.match(/class="ai-mark"/g)).toHaveLength(4)
    expect(html).not.toContain('k-btn-primary')
  })
})

describe('General has no box of its own', () => {
  test('the strip is the one place', () => {
    const html = renderToStaticMarkup(
      <WorkspaceGeneral canEdit name="Brightwater" onRenamed={() => {}} toast={() => {}} />,
    )
    expect(html).not.toContain('Finish setting up')
    expect(html).not.toContain('k-note-info')
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
