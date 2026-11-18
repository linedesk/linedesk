import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../admin/api.ts', () => ({ runAdmin: vi.fn(async () => ({})) }))
const {
  agentSetupWayBack,
  backToAgentSetup,
  choseManualSetup,
  ownerAgentSetupDue,
  openPartnerActivate,
  ownerChoseByHand,
  PARTNER_ACTIVATE_HASH,
  PARTNER_AGENT_HASH,
  PARTNER_CLIENTS_HASH,
  partnerActivateBack,
  partnerChoseByHand,
  partnerLanding,
  rememberManual,
  rememberOwnerByHand,
  rememberPartnerByHand,
} = await import('./setup-choice.ts')
const { runAdmin } = await import('../admin/api.ts')

beforeEach(() => {
  // What an earlier install left in this browser (LIN-181).
  const memory = new Map<string, string>([['linedesk.setup.manual', '1']])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(runAdmin).mockClear()
})

describe('set up by hand: the choice belongs to the admin and the install', () => {
  it('a new install opens on the agent setup page, whatever this browser kept from before', () => {
    expect(choseManualSetup({ setupByHand: false }, false)).toBe(false)
    expect(choseManualSetup({}, false)).toBe(false)
    expect(choseManualSetup(null, false)).toBe(false)
  })

  it('this admin chose by hand on this install: the walkthrough or their business, not the agent page', () => {
    expect(choseManualSetup({ setupByHand: true }, false)).toBe(true)
  })

  it('another admin, or the same person on another install: the server says no, so the agent page', () => {
    // /v1/me.setupByHand is per admin and per install (apps/api/test/install-setup.test.ts).
    expect(choseManualSetup({ setupByHand: false }, false)).toBe(false)
  })

  it('chosen just now in this tab counts before /v1/me is read again', () => {
    expect(choseManualSetup({ setupByHand: false }, true)).toBe(true)
  })

  it('remembers the choice on the server, never in the browser', async () => {
    rememberManual(true)
    rememberManual(false)
    expect(vi.mocked(runAdmin).mock.calls).toEqual([
      ['install.setProgress', { manual: true }],
      ['install.setProgress', { manual: false }],
    ])
    expect(localStorage.getItem('linedesk.setup.manual')).toBe('1') // untouched and unread
  })

  it('a failed save does not throw: the choice lasts this page', async () => {
    vi.mocked(runAdmin).mockRejectedValueOnce(new Error('offline'))
    expect(() => rememberManual(true)).not.toThrow()
    await Promise.resolve()
  })
})

describe("a workspace owner's setup: the agent first, by hand as the alternative", () => {
  const onboarding = {
    step: 'business' as const,
    phone: { provider: null, available: false, detail: null, canAttach: false },
  }
  const owner = { role: 'owner', onboarding, impersonation: null, workspace: { id: 'ws_1', name: 'Brightwater' } }
  const due = (
    me: Partial<typeof owner> & Record<string, unknown>,
    more: Partial<{ instanceAdmin: boolean; hashOpen: boolean; byHand: boolean }> = {},
  ) =>
    ownerAgentSetupDue({ ...owner, ...me } as never, { instanceAdmin: false, hashOpen: false, byHand: false, ...more })

  it('opens for the owner while onboarding is open, and on #setup-agent', () => {
    expect(due({})).toBe(true)
    expect(due({ onboarding: null } as never)).toBe(false)
    expect(due({ onboarding: null } as never, { hashOpen: true })).toBe(true)
    expect(due({}, { byHand: true })).toBe(false)
  })

  it('never for an admin or member of the workspace, a server admin, an impersonation, an unconfirmed address or a disabled workspace', () => {
    expect(due({ role: 'admin' })).toBe(false)
    expect(due({ role: 'member' }, { hashOpen: true })).toBe(false)
    expect(due({}, { instanceAdmin: true, hashOpen: true })).toBe(false)
    expect(due({ impersonation: { by: 'x' } } as never)).toBe(false)
    expect(due({ emailUnconfirmed: true } as never)).toBe(false)
    expect(due({ workspace: { id: 'ws_1', name: 'B', disabled: true } } as never)).toBe(false)
  })

  it('also while the workspace waits for its trial: the agent first, the card on its page (2026-11-18)', () => {
    const pending = { workspace: { id: 'ws_1', name: 'B', billingState: 'pending_payment' } } as never
    expect(due(pending)).toBe(true)
    expect(due(pending, { hashOpen: true })).toBe(true)
    expect(due(pending, { byHand: true })).toBe(false)
  })

  it('not for a waiting workspace whose setup was done before (it left its partner): only the card, by hand', () => {
    const onlyCard = {
      workspace: { id: 'ws_1', name: 'B', billingState: 'pending_payment' },
      onboarding: { ...onboarding, step: 'activate', onlyCard: true },
    } as never
    expect(due(onlyCard)).toBe(false)
    expect(due(onlyCard, { hashOpen: true })).toBe(false)
  })

  it('remembers by hand per workspace in this browser, and forgets it again', () => {
    expect(ownerChoseByHand('ws_1', false)).toBe(false)
    expect(ownerChoseByHand('ws_1', true)).toBe(true)
    rememberOwnerByHand('ws_1', true)
    expect(ownerChoseByHand('ws_1', false)).toBe(true)
    expect(ownerChoseByHand('ws_2', false)).toBe(false)
    rememberOwnerByHand('ws_1', false)
    expect(ownerChoseByHand('ws_1', false)).toBe(false)
  })
})

describe("a partner owner's way after the partner Checkout (2026-11-18)", () => {
  it('lands on the agent setup, unless they chose the partner area by hand for this partner here', () => {
    expect(partnerLanding('p_1')).toBe('#partner/agent')
    rememberPartnerByHand('p_1', true)
    expect(partnerChoseByHand('p_1')).toBe(true)
    expect(partnerLanding('p_1')).toBe('#partner')
    expect(partnerLanding('p_2')).toBe('#partner/agent')
    // "Set up with an AI agent" in the partner area takes the choice back.
    rememberPartnerByHand('p_1', false)
    expect(partnerLanding('p_1')).toBe('#partner/agent')
    // No partner in the return address: the partner area.
    expect(partnerLanding(null)).toBe('#partner')
  })
})

describe('set up by hand after all: every step goes back to the agent setup (2026-11-18)', () => {
  const onboarding = {
    step: 'pickup' as const,
    phone: { provider: null, available: false, detail: null, canAttach: false },
  }
  const owner = {
    role: 'owner',
    onboarding,
    impersonation: null,
    workspace: { id: 'ws_1', name: 'Brightwater' },
    partners: [] as unknown[],
  }
  const way = (me: Record<string, unknown>, instanceAdmin = false) =>
    agentSetupWayBack({ ...owner, ...me } as never, { instanceAdmin })
  const partnerOwner = { id: 'p_1', name: 'Northline', status: 'active', role: 'owner' }

  it("an instance admin: the install's page; a workspace owner: their workspace's page", () => {
    expect(way({}, true)).toBe('install')
    expect(way({ role: 'member' }, true)).toBe('install')
    expect(way({})).toBe('owner')
    // A trial sign-up waiting for its card: the agent page has the Start your free trial row.
    expect(way({ workspace: { id: 'ws_1', name: 'B', billingState: 'pending_payment' } })).toBe('owner')
  })

  it("the partner's owner in one of its client workspaces: the partner's page", () => {
    const client = { id: 'ws_2', name: 'Client', viaPartner: true }
    expect(way({ role: 'admin', workspace: client, partners: [partnerOwner] })).toBe('partner')
    // The client's own owner: their workspace's page.
    expect(way({ workspace: client, partners: [] })).toBe('owner')
  })

  it('nobody the agent setup is not for: a member or admin, a partner admin, a suspended partner, an impersonation', () => {
    expect(way({ role: 'admin' })).toBeNull()
    expect(way({ role: 'member' })).toBeNull()
    const client = { id: 'ws_2', name: 'Client', viaPartner: true }
    expect(way({ role: 'admin', workspace: client, partners: [{ ...partnerOwner, role: 'admin' }] })).toBeNull()
    expect(way({ role: 'admin', workspace: client, partners: [{ ...partnerOwner, status: 'suspended' }] })).toBeNull()
    // The partner's owner in a workspace that is not a client of theirs.
    expect(way({ role: 'admin', partners: [partnerOwner] })).toBeNull()
    expect(way({ impersonation: { by: 'x' } }, true)).toBeNull()
    expect(way({ impersonation: { by: 'x' } })).toBeNull()
    // The same rules as the owner's page itself: a confirmed address, a workspace that is not disabled.
    expect(way({ emailUnconfirmed: true })).toBeNull()
    expect(way({ workspace: { id: 'ws_1', name: 'B', disabled: true } })).toBeNull()
    const onlyCard = { ...onboarding, step: 'activate', onlyCard: true }
    expect(
      way({ onboarding: onlyCard, workspace: { id: 'ws_1', name: 'B', billingState: 'pending_payment' } }),
    ).toBeNull()
  })

  describe('going back forgets the choice to go by hand, and nothing else', () => {
    beforeEach(() => vi.stubGlobal('window', { location: { hash: '' } }))

    it('an instance admin: on the server, then the agent page', () => {
      backToAgentSetup('install', owner as never)
      expect(vi.mocked(runAdmin).mock.calls).toEqual([['install.setProgress', { manual: false }]])
      expect(window.location.hash).toBe('#setup-agent')
    })

    it("a workspace owner: this workspace's choice in this browser, then the agent page", () => {
      rememberOwnerByHand('ws_1', true)
      rememberOwnerByHand('ws_2', true)
      backToAgentSetup('owner', owner as never)
      expect(ownerChoseByHand('ws_1', false)).toBe(false)
      expect(ownerChoseByHand('ws_2', false)).toBe(true)
      expect(window.location.hash).toBe('#setup-agent')
      expect(runAdmin).not.toHaveBeenCalled()
    })

    it("a partner's owner: this partner's choice in this browser, then the partner's agent page", () => {
      rememberPartnerByHand('p_1', true)
      backToAgentSetup('partner', { ...owner, partners: [partnerOwner] } as never)
      expect(partnerChoseByHand('p_1')).toBe(false)
      expect(window.location.hash).toBe('#partner/agent')
    })
  })
})

it('the one Activate step: Back leads to the page it was opened from, else the by-hand Clients step', () => {
  const store = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  const location = { hash: '' }
  vi.stubGlobal('window', { location })
  expect(partnerActivateBack()).toBe(PARTNER_CLIENTS_HASH)
  openPartnerActivate(PARTNER_AGENT_HASH)
  expect(location.hash).toBe(PARTNER_ACTIVATE_HASH)
  expect(partnerActivateBack()).toBe('#partner/agent')
  openPartnerActivate('#partner')
  expect(partnerActivateBack()).toBe('#partner')
  openPartnerActivate(null)
  expect(partnerActivateBack()).toBe('#partner/setup/clients')
})
