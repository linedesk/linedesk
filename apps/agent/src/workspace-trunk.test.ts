// The transfer trunk of a workspace's own carrier account: the API names and sets it up; the agent reuses it
// by its exact name, asks for it again when missing, and once more when the carrier refuses its credentials.
import type { SipClient } from 'livekit-server-sdk'
import { describe, expect, test, vi } from 'vitest'
import type { ApiClient } from './api-client.ts'
import { NotAnsweredError } from './on-call-dialer.ts'
import { isCredentialRefusal, ownTransferTrunk, transferRoute, workspaceTrunkDialer } from './workspace-trunk.ts'

const WS = { workspaceId: 'ws_1', token: 'ldcall_t' }
const FROM = '+15035550142'
const NAME = 'linedesk-outbound-ws_1-0123456789ab'

function fakeApi() {
  const run = vi.fn(async (def: { name: string }) => ({
    ok: true as const,
    rows: {},
    data: def.name === 'carrier.transferTrunk' ? { carrier: 'twilio', trunkName: NAME } : { trunkId: 'ST_new' },
  }))
  return { api: { run, providerSettings: async () => ({}) } as unknown as ApiClient, run }
}

const fakeSip = (trunks: { sipTrunkId: string; name: string; numbers: string[] }[]) =>
  ({ listSipOutboundTrunk: vi.fn(async () => trunks) }) as unknown as SipClient

const request = () => ({ room: 'r', identity: 'oncall', signal: new AbortController().signal })

describe('workspace transfer trunk', () => {
  test('asks the API how the called number transfers, for that workspace', async () => {
    const { api, run } = fakeApi()
    expect(await transferRoute(api, WS, FROM)).toEqual({ carrier: 'twilio', trunkName: NAME })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: 'carrier.transferTrunk' }), { from: FROM }, WS)
  })

  test('reuses the trunk of that exact name with the caller ID, without asking for a new one', async () => {
    const { api, run } = fakeApi()
    const sip = fakeSip([{ sipTrunkId: 'ST_1', name: NAME, numbers: [FROM] }])
    expect(await ownTransferTrunk(api, sip, WS, NAME, FROM)).toBe('ST_1')
    expect(run).not.toHaveBeenCalled()
  })

  test('a trunk of another account (other fingerprint) or without the caller ID is not used: the API sets one up', async () => {
    const { api, run } = fakeApi()
    const sip = fakeSip([
      { sipTrunkId: 'ST_old_account', name: 'linedesk-outbound-ws_1-ffffffffffff', numbers: [FROM] },
      { sipTrunkId: 'ST_no_number', name: NAME, numbers: ['+15035550199'] },
    ])
    expect(await ownTransferTrunk(api, sip, WS, NAME, FROM)).toBe('ST_new')
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: 'carrier.provisionTransferTrunk' }), {}, WS)
  })

  test('finds the trunk only when it dials; a credential refusal re-provisions once, other failures do not', async () => {
    const trunk = vi.fn(async () => 'ST_1')
    const reprovision = vi.fn(async () => 'ST_2')
    const dialled: string[] = []
    let failures = [new Error('SIP status: 407 Proxy Authentication Required')]
    const dialer = workspaceTrunkDialer(trunk, reprovision, trunkId => ({
      dial: async () => {
        dialled.push(trunkId)
        const failure = failures.shift()
        if (failure) throw failure
      },
    }))
    expect(trunk).not.toHaveBeenCalled()
    await dialer.dial(request())
    expect(dialled).toEqual(['ST_1', 'ST_2'])
    expect(reprovision).toHaveBeenCalledOnce()

    failures = [new NotAnsweredError('busy 486')]
    await expect(dialer.dial(request())).rejects.toBeInstanceOf(NotAnsweredError)
    expect(reprovision).toHaveBeenCalledOnce()
  })

  test('what counts as a credential refusal', () => {
    expect(isCredentialRefusal(new Error('SIP 401 Unauthorized'))).toBe(true)
    // Twilio's 403 is also "destination not allowed": a new password would not help.
    expect(isCredentialRefusal(new Error('SIP 403 Forbidden'))).toBe(false)
    expect(isCredentialRefusal(new Error('Unauthorized'))).toBe(true)
    expect(isCredentialRefusal(new NotAnsweredError('401'))).toBe(false)
    expect(isCredentialRefusal(new Error('486 Busy Here'))).toBe(false)
  })
})
