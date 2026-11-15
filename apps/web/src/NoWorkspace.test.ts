import type { AgentSetupState } from '@linedesk/actions'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Me } from './auth.ts'
import { secondFactorDue } from './CreateWorkspace.tsx'
import { mayCreateWorkspace, pendingInvitations } from './NoWorkspace.tsx'
import { ByHand } from './onboarding/AdminStart.tsx'

const now = new Date('2026-11-11T12:00:00Z')
const row = (
  over: Partial<{ id: string; organizationName: string; role: string; status: string; expiresAt: string }>,
) => ({
  id: 'inv_1',
  organizationName: 'Alpha Plumbing',
  role: 'member',
  status: 'pending',
  expiresAt: '2026-11-12T12:00:00Z',
  ...over,
})
const me = (permissions: string[], adminSecondFactor: Me['adminSecondFactor'] = null): Me => ({
  actorId: 'u1',
  role: 'member',
  permissions,
  workspace: null,
  onboarding: null,
  phoneSetup: null,
  impersonation: null,
  adminSecondFactor,
})

describe('someone without a workspace', () => {
  it('sees the invitations they can still answer, also one they skipped with "Not now"', () => {
    const rows = [
      row({ id: 'inv_open' }),
      row({ id: 'inv_old', expiresAt: '2026-11-10T12:00:00Z' }),
      row({ id: 'inv_done', status: 'accepted' }),
      row({ id: 'inv_gone', status: 'canceled' }),
    ]
    expect(pendingInvitations(rows, now)).toEqual([{ id: 'inv_open', workspaceName: 'Alpha Plumbing', role: 'member' }])
  })

  it('names a business only as a server admin; everyone else waits for an invitation', () => {
    expect(mayCreateWorkspace(null)).toBe(false)
    expect(mayCreateWorkspace(me([]))).toBe(false)
    expect(mayCreateWorkspace(me(['instance:admin']))).toBe(true)
  })

  it('a server admin names a business only after the passkey check (the server refuses it before)', () => {
    expect(mayCreateWorkspace(me([], 'confirm'))).toBe(false)
    expect(mayCreateWorkspace(me([], 'enrol'))).toBe(false)
    expect(mayCreateWorkspace(me([], 'email'))).toBe(false)
  })
})

describe('a refused workspace creation', () => {
  it('opens the passkey check when /v1/me says it is due, and shows the error otherwise', async () => {
    expect(await secondFactorDue(async () => me([], 'confirm'))).toBe('confirm')
    expect(await secondFactorDue(async () => me([], 'enrol'))).toBe('enrol')
    expect(await secondFactorDue(async () => me(['instance:admin']))).toBeNull()
    expect(await secondFactorDue(async () => null)).toBeNull()
    expect(await secondFactorDue(() => Promise.reject(new Error('offline')))).toBeNull()
  })
})

describe('the start page by hand (AdminStart)', () => {
  const state = (installDone: boolean) =>
    ({
      progress: { steps: installDone ? [] : [{ id: 'email', state: 'todo' }] },
    }) as unknown as AgentSetupState
  const render = (props: Partial<Parameters<typeof ByHand>[0]>) =>
    renderToStaticMarkup(
      createElement(ByHand, {
        state: null,
        checkDue: null,
        loadFailed: false,
        onConfirm: () => {},
        onRetry: () => {},
        onInstallByHand: () => {},
        onDone: () => {},
        onSecondFactor: () => {},
        ...props,
      }),
    )

  it('offers the passkey check instead of the business form while it is due', () => {
    const button = { confirm: 'Confirm with your passkey', enrol: 'Add a passkey', email: 'Confirm your email first' }
    for (const checkDue of ['confirm', 'enrol', 'email'] as const) {
      const html = render({ checkDue, state: state(true) })
      expect(html).toContain(button[checkDue])
      expect(html).not.toContain('Business name')
    }
    // The address comes first: the button is about the email, not the passkey.
    expect(render({ checkDue: 'email' })).not.toContain('Confirm with your passkey')
  })

  it('a setup state that does not load: the error with Try again, and the business form still below it', () => {
    const html = render({ loadFailed: true })
    expect(html).toContain('could not be loaded')
    expect(html).toContain('Try again')
    expect(html).toContain('Business name')
    // While the check is due, still only the check.
    expect(render({ loadFailed: true, checkDue: 'confirm' })).not.toContain('Business name')
  })

  it('shows the business form only once the setup state is known and the server parts are in place', () => {
    // While it loads: the shared skeleton (busy for screen readers), no form yet.
    expect(render({})).toContain('aria-busy="true"')
    expect(render({})).not.toContain('Business name')
    expect(render({ state: state(true) })).toContain('Business name')
    // The server's parts are missing: they come first.
    expect(render({ state: state(false) })).toContain('Set up the server by hand')
    expect(render({ state: state(false) })).not.toContain('Business name')
  })
})
