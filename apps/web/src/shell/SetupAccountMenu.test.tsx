// The setup pages' account menu (SetupAccountMenu.tsx, 2026-11-18): a round button in the top bar of every setup page
// (SetupTopBar.tsx), also when the steps are gone through again from the settings, the workspaces only when there is somewhere else
// to go, and Sign out that works without a workspace's data (a setup page outside the store) and touches nothing of the
// setup's progress.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('../auth.ts', () => ({
  auth: {
    useSession: () => ({ data: { user: { name: 'Mike Brennan', email: 'mike@example.com', image: null } } }),
    signOut: async () => void calls.push('auth.signOut'),
  },
}))
vi.mock('../partner/partner-api.ts', () => ({ useMyPartners: () => [] }))
vi.mock('./WorkspaceSwitcher.tsx', () => ({
  useWorkspaces: () => [{ id: 'ws_1', name: 'Brightwater' }],
  refreshWorkspaces: async () => {},
  WorkspaceSwitcher: () => null,
}))
vi.mock('../localData.ts', () => ({ forgetLocalData: async () => void calls.push('forgetLocalData') }))
vi.mock('../push.ts', () => ({ stopPushOnSignOut: async () => void calls.push('stopPush') }))
vi.mock('./useRoute.ts', () => ({ clearRoute: () => void calls.push('clearRoute') }))
vi.mock('../store.tsx', () => ({ useOptionalStore: () => null }))

const { SetupAccountMenu, setupMenuSwitches } = await import('./SetupAccountMenu.tsx')
const { useSignOut } = await import('./useSignOut.ts')
const { Frame } = await import('../onboarding/Frame.tsx')

describe('the account menu in the setup top bar', () => {
  test('a round button with the initials, named for screen readers', () => {
    const html = renderToStaticMarkup(<SetupAccountMenu workspaceId="ws_1" />)
    expect(html).toContain('aria-label="Your account"')
    expect(html).toContain('title="Signed in as Mike Brennan"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('>MB<')
  })

  test('on every onboarding step, last in the top bar; also when gone through again from the settings', () => {
    const top = (edit: boolean) => {
      const html = renderToStaticMarkup(
        <Frame step="pickup" complete={false} edit={edit} onSkip={() => {}}>
          <p>step</p>
        </Frame>,
      )
      return html.slice(html.indexOf('ob-top'), html.indexOf('ob-bar'))
    }
    expect(top(false)).toContain('aria-label="Your account"')
    expect(top(false).indexOf('Finish later')).toBeLessThan(top(false).indexOf('Your account'))
    // Every signed-in setup page shows it (2026-11-18), "Step by step" from the settings too, after its Close.
    expect(top(true)).toContain('aria-label="Your account"')
    expect(top(true).indexOf('Close')).toBeLessThan(top(true).indexOf('Your account'))
  })

  test('the step count also in short, for a phone', () => {
    const html = renderToStaticMarkup(
      <Frame step="assistant" complete={false}>
        <p>step</p>
      </Frame>,
    )
    expect(html).toContain('<span class="ob-count-short" aria-hidden="true">2/6</span>')
  })

  test('the workspaces only when there is another one or a partner area', () => {
    expect(setupMenuSwitches(1, 0)).toBe(false)
    expect(setupMenuSwitches(0, 0)).toBe(false)
    expect(setupMenuSwitches(2, 0)).toBe(true)
    expect(setupMenuSwitches(1, 1)).toBe(true)
  })

  test('outside any workspace (partner area, partner setup) a single workspace is somewhere else to go', () => {
    expect(setupMenuSwitches(1, 0, false)).toBe(true)
    expect(setupMenuSwitches(0, 1, false)).toBe(true)
    expect(setupMenuSwitches(0, 0, false)).toBe(false)
  })
})

const probe = { signOut: null as (() => Promise<void>) | null, onSignedOut: vi.fn() }
/** Keeps the sign-out a setup page gets, outside any StoreProvider. */
function Probe() {
  probe.signOut = useSignOut({ onSignedOut: probe.onSignedOut, toast: () => {} })
  return null
}

describe('signing out mid-setup', () => {
  test('works without a workspace store, and does nothing else (the progress stays on the server)', async () => {
    renderToStaticMarkup(<Probe />)
    await probe.signOut!()
    expect(calls).toEqual(['stopPush', 'auth.signOut', 'forgetLocalData', 'clearRoute'])
    expect(probe.onSignedOut).toHaveBeenCalledOnce()
  })
})
