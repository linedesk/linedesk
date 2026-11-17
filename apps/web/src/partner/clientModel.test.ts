import type { PartnerClient, PartnerClientMember } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import { barWidth, clientActions, othersThanOwner, problemTone, usageTone, usedNothing } from './clientModel.ts'

const client = (owner: PartnerClient['owner'], others: PartnerClient['otherMembers'] = []): PartnerClient => ({
  id: 'ws_1',
  name: 'Rivera Plumbing',
  createdAt: '2026-11-01T10:00:00Z',
  owner,
  otherMembers: others,
  invitedByTeam: [],
})
const person = (name: string, role: PartnerClientMember['role']): PartnerClientMember => ({
  name,
  email: `${name}@x.co`,
  role,
  invitedBy: null,
})

describe('Partner › Clients', () => {
  it('shows what stops calls or money in red, the rest in amber', () => {
    expect(
      (['bill_inactive', 'disabled', 'limit_reached', 'forwarding_failed'] as const).map(p => problemTone(p)),
    ).toEqual(['danger', 'danger', 'danger', 'danger'])
    expect(
      (['limit_near', 'no_number', 'forwarding_unverified', 'provider_errors'] as const).map(p => problemTone(p)),
    ).toEqual(['warning', 'warning', 'warning', 'warning'])
  })

  it('colours the usage bar amber from 80 % and red at the limit, and never fills it past the end', () => {
    expect([null, 0, 79, 80, 99, 100, 140].map(usageTone)).toEqual([
      null,
      null,
      null,
      'warning',
      'warning',
      'danger',
      'danger',
    ])
    expect([-5, 0, 42, 100, 140].map(barWidth)).toEqual([0, 0, 42, 100, 100])
  })

  it('shows a dash for a client that used nothing this period', () => {
    expect(usedNothing({ calls: 0, seconds: 0, costCents: null })).toBe(true)
    expect(usedNothing({ calls: 0, seconds: 0, costCents: 0 })).toBe(true)
    expect(usedNothing({ calls: 1, seconds: 30, costCents: 4 })).toBe(false)
  })

  it('never names the owner again under "Also in it"', () => {
    const c = client({ name: 'Carlos', email: 'carlos@x.co' } as never, [
      person('Carlos', 'owner'),
      person('Jordan', 'admin'),
    ])
    expect(othersThanOwner(c).map(m => m.name)).toEqual(['Jordan'])
    expect(othersThanOwner(undefined)).toEqual([])
  })

  it("offers Settings to everyone (on the partner bill only) and the owner's next step to the partner's owner", () => {
    const none = client(null)
    const invited = client({ invited: 'dana@x.co' })
    const accepted = client({ name: 'Carlos', email: 'carlos@x.co' })
    expect(clientActions({ billed: true }, none, false)).toEqual([{ id: 'settings', enabled: true }])
    expect(clientActions({ billed: false }, none, false)).toEqual([{ id: 'settings', enabled: false }])
    expect(clientActions({ billed: true }, none, true).map(a => a.id)).toEqual(['settings', 'inviteOwner'])
    expect(clientActions({ billed: true }, invited, true).map(a => a.id)).toEqual(['settings', 'ownerInvitation'])
    expect(clientActions({ billed: true }, accepted, true).map(a => a.id)).toEqual(['settings', 'release'])
  })
})
