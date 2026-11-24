import { describe, expect, test } from 'vitest'
import { checkResultText, forwardingUnverified, lineText, lookupGuide, ownerPick } from './forwarding-check.ts'

describe('forwarding check results', () => {
  test('works says how long it rang, and has nothing more to do', () => {
    expect(checkResultText({ status: 'works', ringSeconds: 18, detail: null }, 'Maya')).toEqual({
      title: 'Verified: calls you don’t answer reach Maya after about 18 seconds.',
      next: null,
      ok: true,
    })
  })

  test('every other result has one next thing to try', () => {
    for (const status of [
      'rang_through',
      'answered',
      'busy',
      'unreachable',
      'forwards_elsewhere',
      'no_assistant',
      'not_checked',
    ] as const) {
      const text = checkResultText({ status, ringSeconds: null, detail: null }, 'Maya')
      expect(text.ok).toBe(false)
      expect(text.next).toBeTruthy()
    }
    expect(
      checkResultText(
        { status: 'not_checked', ringSeconds: null, detail: 'Could not check: no number to call from.' },
        'Maya',
      ).next,
    ).toMatch(/^Could not check: no number to call from\. Call your business number/)
  })

  test('a simulated check (development carrier) never reads as verified', () => {
    expect(checkResultText({ status: 'works', ringSeconds: 3, detail: null, simulated: true }, 'Maya')).toEqual({
      title: 'Simulated: calls you don’t answer would reach Maya.',
      next: null,
      ok: false,
    })
  })

  test('a line that does not forward missed calls offers forward-all and the assistant’s own number', () => {
    expect(checkResultText({ status: 'rang_through', ringSeconds: null, detail: null }, 'Maya').fixes).toEqual([
      'forward_all',
      'new',
    ])
    expect(checkResultText({ status: 'rang_through', ringSeconds: null, detail: null }, 'Maya', true).fixes).toBe(
      undefined,
    )
  })

  test('forward-all speaks of every call, not the unanswered ones', () => {
    expect(checkResultText({ status: 'works', ringSeconds: null, detail: null }, 'Maya', true).title).toBe(
      'Verified: calls to your business number reach Maya.',
    )
    expect(checkResultText({ status: 'rang_through', ringSeconds: null, detail: null }, 'Maya', true).next).toMatch(
      /forward-all code/,
    )
  })

  test('the line reads carrier and type', () => {
    expect(lineText({ lineType: 'mobile', carrier: 'Verizon Wireless', carrierId: 'verizon', simulated: false })).toBe(
      'Verizon Wireless · mobile',
    )
    expect(lineText({ lineType: 'voip', carrier: null, carrierId: null, simulated: false })).toBe('phone system or app')
    expect(lineText({ lineType: 'unknown', carrier: null, carrierId: null, simulated: false })).toBeNull()
  })
})

describe('the carrier lookup and the guide the owner picked', () => {
  test('a pick saved without a source is the owner’s; one from a lookup is not', () => {
    expect(ownerPick('att-business', null)).toBe('att-business')
    expect(ownerPick('verizon', 'lookup')).toBeNull()
    expect(ownerPick(null, null)).toBeNull()
  })

  test('the lookup preselects while the owner has not picked by hand', () => {
    expect(lookupGuide('verizon', null)).toEqual({ preselect: 'verizon' })
  })

  test('the lookup never replaces a pick by hand: it suggests its carrier instead', () => {
    expect(lookupGuide('verizon', 'att-business')).toEqual({ suggest: 'verizon' })
    expect(lookupGuide('verizon', 'verizon')).toBeNull()
    expect(lookupGuide(null, 'att-business')).toBeNull()
    expect(lookupGuide(null, null)).toBeNull()
  })

  test('a forwarding number is unverified until a check works or a real caller comes through', () => {
    const n = {
      e164: '+15550000001',
      mode: 'forward_conditional' as const,
      verified_at: null,
      created_at: '2026-11-12T10:00:00Z',
    }
    const call = {
      source: 'phone' as const,
      direction: 'in' as const,
      from_own_number: false,
      outcome: 'message' as const,
      to_number: n.e164,
      started_at: '2026-11-13T09:00:00Z',
    }
    expect(forwardingUnverified(n, [])).toBe(true)
    expect(forwardingUnverified({ ...n, verified_at: '2026-11-13T10:00:00Z' }, [])).toBe(false)
    expect(forwardingUnverified(n, [call])).toBe(false)
    expect(forwardingUnverified(n, [{ ...call, source: 'test' }])).toBe(true)
    expect(forwardingUnverified(n, [{ ...call, from_own_number: true }])).toBe(true)
    // The server's rule: incoming, not spam, after the number was set up.
    expect(forwardingUnverified(n, [{ ...call, direction: 'out' }])).toBe(true)
    expect(forwardingUnverified(n, [{ ...call, outcome: 'spam' }])).toBe(true)
    expect(forwardingUnverified(n, [{ ...call, started_at: '2026-11-11T09:00:00Z' }])).toBe(true)
    expect(forwardingUnverified({ ...n, mode: 'new' }, [])).toBe(false)
  })
})
