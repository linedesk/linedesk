import { describe, expect, it, vi } from 'vitest'
import { callerAttestation, spamLikely, warnIfNoSipHeaders } from './caller-attestation.ts'

// As LiveKit SIP put a Telnyx call on staging into the caller's attributes (2026-11-15).
const telnyx = (verstat: string) => ({
  'sip.phoneNumber': '+15035550192',
  'sip.h.from': '"+15035550192" <sip:+15035550192@sip.telnyx.com>;tag=BK8gr4pQj3cFK',
  'sip.h.p-asserted-identity': `"+15035550192"<sip:+15035550192@sip.telnyx.com;verstat=${verstat}>`,
})

describe('callerAttestation', () => {
  it('reads the level Telnyx puts on P-Asserted-Identity', () => {
    expect(callerAttestation(telnyx('TN-Validation-Passed'))).toBe('A')
    expect(callerAttestation(telnyx('TN-Validation-Passed-A'))).toBe('A')
    expect(callerAttestation(telnyx('TN-Validation-Passed-B'))).toBe('B')
    expect(callerAttestation(telnyx('TN-Validation-Passed-C'))).toBe('C')
    expect(callerAttestation(telnyx('TN-Validation-Failed'))).toBe('failed')
    expect(callerAttestation(telnyx('No-TN-Validation'))).toBe('none')
  })

  it("reads Twilio's X-Twilio-VerStat on a call Twilio delivered; a forwarded call keeps its level", () => {
    const twilio = (verstat: string) => ({
      'sip.hostname': 'linedesk.pstn.twilio.com',
      'sip.h.x-twilio-verstat': verstat,
    })
    expect(callerAttestation(twilio('TN-Validation-Passed-A'))).toBe('A')
    expect(callerAttestation(twilio('TN-Validation-Passed-A-Diverted'))).toBe('A')
    expect(callerAttestation(twilio('TN-Validation-Passed-B-Diverted'))).toBe('B')
    expect(callerAttestation(twilio('TN-Validation-Failed-A'))).toBe('failed')
  })

  it("never takes what the caller's side writes: From, a display name, another carrier's X-Twilio-VerStat", () => {
    expect(
      callerAttestation({ 'sip.h.from': '<sip:+15035550123@carrier.example;verstat=TN-Validation-Passed>;tag=1' }),
    ).toBe('none')
    expect(
      callerAttestation({
        'sip.h.p-asserted-identity':
          '"x;verstat=TN-Validation-Passed" <sip:+15035550123@sip.telnyx.com;verstat=No-TN-Validation>',
      }),
    ).toBe('none')
    expect(
      callerAttestation({
        ...telnyx('No-TN-Validation'),
        'sip.hostname': 'sip.telnyx.com',
        'sip.h.x-twilio-verstat': 'TN-Validation-Passed-A',
      }),
    ).toBe('none')
    expect(
      callerAttestation({ 'sip.hostname': 'sip.telnyx.com', 'sip.h.x-twilio-verstat': 'TN-Validation-Passed-A' }),
    ).toBe('none')
  })

  it('two different levels in one header count as none', () => {
    expect(
      callerAttestation({
        'sip.h.p-asserted-identity':
          '<sip:+1503@a;verstat=TN-Validation-Passed>, <sip:+1503@b;verstat=TN-Validation-Passed-C>',
      }),
    ).toBe('none')
  })

  it('headers without a verstat (an INVITE someone sent from a carrier address): none; no headers at all: unknown', () => {
    expect(callerAttestation({ 'sip.h.from': '<sip:+15035550123@carrier.example>' })).toBe('none')
    expect(callerAttestation({ 'sip.phoneNumber': '+15035550123' })).toBeUndefined()
  })

  it('warns once per worker when a call comes without SIP headers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnIfNoSipHeaders(telnyx('TN-Validation-Passed'))
    expect(warn).not.toHaveBeenCalled()
    warnIfNoSipHeaders({ 'sip.phoneNumber': '+15035550123' })
    warnIfNoSipHeaders({ 'sip.phoneNumber': '+15035550124' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/setup-sip/)
    warn.mockRestore()
  })

  it('an unknown verstat value never counts as verified', () => {
    expect(callerAttestation(telnyx('TN-Validation-Passed-Z'))).toBe('none')
    expect(callerAttestation(telnyx('Something-Else'))).toBe('none')
  })
})

describe('spamLikely', () => {
  it("is the flag of Telnyx's call screening", () => {
    expect(spamLikely({ 'sip.h.x-telnyx-call-screening': 'SPAM LIKELY' })).toBe(true)
    expect(spamLikely({ 'sip.h.from': '"SPAM LIKELY" <sip:+15035550123@sip.telnyx.com>' })).toBe(false)
    expect(spamLikely({})).toBe(false)
  })
})
