// Numbers that need documents (KYC): the Telnyx adapter against mocked HTTP, and the dev stand-in. Never a real key.
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createTelnyxProvider,
  decideDevReview,
  devProvider,
  telnyxGroupStatus,
  telnyxOrderStatus,
  TelephonyError,
} from './index.ts'

// biome-ignore lint/suspicious/noExplicitAny: request bodies are asserted on in the tests
type Call = { method: string; path: string; body?: any }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const NOW = 1_800_000_000_000
const NUMBER = '+493055501000'

function mockTelnyx(route: (call: Call) => { status?: number; json: unknown } | undefined) {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const call = {
      method: init!.method!,
      path: decodeURIComponent(String(url).replace('https://api.telnyx.com/v2', '')),
      body: init!.body ? JSON.parse(String(init!.body)) : undefined,
    }
    calls.push(call)
    const { status = 200, json } = route(call) ?? {
      status: 404,
      json: { errors: [{ detail: `no mock for ${call.method} ${call.path}` }] },
    }
    return Response.json(json, { status })
  }
  const provider = createTelnyxProvider({
    apiKey: 'KEY',
    publicKey: rawPublicKey,
    fetch: fakeFetch,
    wait: async () => {},
    now: () => NOW,
  })
  return { regulatory: provider.regulatory!, provider, calls }
}

function signed(body: object, timestamp = NOW / 1000) {
  const rawBody = JSON.stringify(body)
  const signature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64')
  return { rawBody, headers: { 'telnyx-timestamp': String(timestamp), 'telnyx-signature-ed25519': signature } }
}

describe('telnyx regulatory numbers', () => {
  test('reads the requirements of exactly the country, type and ordering, with their kinds', async () => {
    const { regulatory, calls } = mockTelnyx(() => ({
      json: {
        data: [
          {
            country_code: 'DE',
            phone_number_type: 'local',
            action: 'ordering',
            regulatory_requirements: [
              { id: 'r1', name: 'Business name', field_type: 'textual' },
              { id: 'r2', name: 'Address', field_type: 'address' },
              { id: 'r3', name: 'BNetzA registration form', field_type: 'document', description: 'Signed form' },
            ],
          },
          {
            country_code: 'DE',
            phone_number_type: 'local',
            action: 'porting',
            regulatory_requirements: [{ id: 'r9', name: 'LOA', field_type: 'document' }],
          },
        ],
      },
    }))
    expect(await regulatory.numberRequirements('DE', 'local')).toEqual([
      { id: 'r1', name: 'Business name', kind: 'textual' },
      { id: 'r2', name: 'Address', kind: 'address' },
      { id: 'r3', name: 'BNetzA registration form', kind: 'document', description: 'Signed form' },
    ])
    expect(calls[0]!.path).toBe(
      '/regulatory_requirements?filter[country_code]=DE&filter[phone_number_type]=local&filter[action]=ordering',
    )
  })

  test('uploads a document as base64, makes an address, submits a group and orders with it', async () => {
    const { regulatory, calls } = mockTelnyx(({ method, path }) => {
      if (method === 'POST' && path === '/documents') return { json: { data: { id: 'doc_1' } } }
      if (method === 'POST' && path === '/addresses') return { json: { data: { id: 42 } } }
      if (method === 'POST' && path === '/requirement_groups')
        return { json: { data: { id: 'grp_1', status: 'unapproved' } } }
      if (method === 'POST' && path === '/requirement_groups/grp_1/submit_for_approval')
        return { json: { data: { id: 'grp_1', status: 'pending-approval' } } }
      if (method === 'POST' && path === '/number_orders')
        return {
          json: {
            data: {
              id: 'ord_1',
              status: 'pending',
              requirements_met: false,
              phone_numbers: [{ phone_number: NUMBER }],
            },
          },
        }
    })
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    expect(
      await regulatory.uploadDocument({
        filename: 'bill.pdf',
        contentType: 'application/pdf',
        content,
        customerReference: 'nr_1',
      }),
    ).toBe('doc_1')
    expect(calls.at(-1)!.body).toEqual({ file: 'JVBERg==', filename: 'bill.pdf', customer_reference: 'nr_1' })
    expect(
      await regulatory.createAddress({
        businessName: 'Brightwater GmbH',
        firstName: 'Mike',
        lastName: 'Brennan',
        street: 'Hauptstr. 1',
        locality: 'Berlin',
        postalCode: '10115',
        countryCode: 'DE',
      }),
    ).toBe('42')
    expect(calls.at(-1)!.body).toMatchObject({
      business_name: 'Brightwater GmbH',
      street_address: 'Hauptstr. 1',
      locality: 'Berlin',
      country_code: 'DE',
    })
    const group = await regulatory.submitRequirementGroup({
      country: 'DE',
      type: 'local',
      customerReference: 'nr_1',
      values: [{ requirementId: 'r1', value: 'doc_1' }],
    })
    expect(group).toEqual({ ref: 'grp_1', status: 'pending_approval' })
    expect(calls.find(c => c.path === '/requirement_groups')!.body).toEqual({
      country_code: 'DE',
      phone_number_type: 'local',
      action: 'ordering',
      customer_reference: 'nr_1',
      regulatory_requirements: [{ requirement_id: 'r1', field_value: 'doc_1' }],
    })
    const order = await regulatory.orderNumber({
      e164: NUMBER,
      requirementGroupRef: 'grp_1',
      customerReference: 'nr_1',
    })
    expect(order).toEqual({ ref: 'ord_1', status: 'pending', e164: NUMBER, requirementsMet: false })
    expect(calls.at(-1)!.body).toEqual({
      phone_numbers: [{ phone_number: NUMBER, requirement_group_id: 'grp_1' }],
      customer_reference: 'nr_1',
    })
  })

  test('an order that succeeded carries the number on the account; a declined group its reason', async () => {
    const { regulatory } = mockTelnyx(({ method, path }) => {
      if (method === 'GET' && path === '/number_orders/ord_1')
        return {
          json: {
            data: { id: 'ord_1', status: 'success', requirements_met: true, phone_numbers: [{ phone_number: NUMBER }] },
          },
        }
      if (method === 'GET' && path.startsWith('/phone_numbers?'))
        return { json: { data: [{ id: 'num_9', phone_number: NUMBER }] } }
      if (method === 'GET' && path === '/requirement_groups/grp_1')
        return {
          json: {
            data: {
              id: 'grp_1',
              status: 'declined',
              regulatory_requirements: [{ requirement_id: 'r3', status: 'declined', reason: 'Form not signed' }],
            },
          },
        }
    })
    expect(await regulatory.getNumberOrder('ord_1')).toEqual({
      ref: 'ord_1',
      status: 'success',
      e164: NUMBER,
      requirementsMet: true,
      number: { e164: NUMBER, providerRef: 'num_9' },
    })
    expect(await regulatory.getRequirementGroup('grp_1')).toEqual({
      ref: 'grp_1',
      status: 'declined',
      reason: 'Form not signed',
    })
  })

  test('cancelling cancels the sub-orders of a pending order, and answers a finished one as it is', async () => {
    let status = 'pending'
    const { regulatory, calls } = mockTelnyx(({ method, path }) => {
      if (method === 'GET' && path === '/number_orders/ord_1')
        return {
          json: {
            data: {
              id: 'ord_1',
              status,
              requirements_met: status === 'success',
              phone_numbers: [{ phone_number: '+4930555000' }],
              sub_number_orders_ids: ['sub_1', 'sub_2'],
            },
          },
        }
      if (method === 'PATCH' && path.startsWith('/sub_number_orders/')) return { json: { data: {} } }
      if (method === 'GET' && path.startsWith('/phone_numbers?'))
        return { json: { data: [{ id: 'num_9', phone_number: '+4930555000' }] } }
    })
    expect(await regulatory.cancelNumberOrder('ord_1')).toMatchObject({ ref: 'ord_1', status: 'cancelled' })
    expect(calls.filter(c => c.method === 'PATCH').map(c => c.path)).toEqual([
      '/sub_number_orders/sub_1/cancel',
      '/sub_number_orders/sub_2/cancel',
    ])
    // Completed meanwhile: nothing is cancelled, and the caller learns the number is on the account.
    status = 'success'
    calls.length = 0
    const done = await regulatory.cancelNumberOrder('ord_1')
    expect(done.status).toBe('success')
    expect(done.e164).toBe('+4930555000')
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([])
  })

  test('a sub-order the carrier refuses to cancel throws (the order is not taken for cancelled)', async () => {
    const { regulatory } = mockTelnyx(({ method, path }) => {
      if (method === 'GET' && path === '/number_orders/ord_1')
        return { json: { data: { id: 'ord_1', status: 'pending', sub_number_orders_ids: ['sub_1'] } } }
      if (method === 'PATCH') return { status: 422, json: { errors: [{ detail: 'not cancellable' }] } }
    })
    await expect(regulatory.cancelNumberOrder('ord_1')).rejects.toThrow(TelephonyError)
  })

  test('a failed order is a not_activated TelephonyError', async () => {
    const { regulatory } = mockTelnyx(({ method }) =>
      method === 'POST' ? { json: { data: { id: 'ord_1', status: 'failure' } } } : undefined,
    )
    await expect(
      regulatory.orderNumber({ e164: NUMBER, requirementGroupRef: 'grp_1', customerReference: 'nr_1' }),
    ).rejects.toMatchObject({ code: 'not_activated' })
  })

  test('webhooks: signed number order and requirement group events in one shape; others null; forged ones refused', () => {
    const { regulatory } = mockTelnyx(() => undefined)
    const order = signed({
      data: {
        id: 'ev1',
        event_type: 'number_order.complete',
        payload: { id: 'ord_1', customer_reference: 'nr_1', status: 'success' },
      },
    })
    expect(regulatory.parseRegulatoryWebhook(order)).toEqual({
      id: 'ev1',
      kind: 'number_order',
      ref: 'ord_1',
      customerReference: 'nr_1',
      providerEventType: 'number_order.complete',
    })
    const sub = signed({
      data: { id: 'ev2', event_type: 'sub_number_order.updated', payload: { id: 'sub_1', order_request_id: 'ord_1' } },
    })
    expect(regulatory.parseRegulatoryWebhook(sub)).toMatchObject({ kind: 'number_order', ref: 'ord_1' })
    const group = signed({
      data: { id: 'ev3', event_type: 'requirement_group.status_updated', payload: { id: 'grp_1' } },
    })
    expect(regulatory.parseRegulatoryWebhook(group)).toMatchObject({ kind: 'requirement_group', ref: 'grp_1' })
    expect(
      regulatory.parseRegulatoryWebhook(signed({ data: { id: 'ev4', event_type: 'call.hangup', payload: {} } })),
    ).toBeNull()
    const forged = { ...order, rawBody: order.rawBody.replace('success', 'failure') }
    expect(() => regulatory.parseRegulatoryWebhook(forged)).toThrow(TelephonyError)
    expect(() => regulatory.parseRegulatoryWebhook({ ...order, headers: {} })).toThrow('no signature headers')
  })

  test('statuses: dashes, both spellings of cancelled, and unknown ones as still pending', () => {
    expect(['pending-approval', 'no-longer-eligible', 'approved', 'weird'].map(telnyxGroupStatus)).toEqual([
      'pending_approval',
      'no_longer_eligible',
      'approved',
      'pending_approval',
    ])
    expect(['success', 'canceled', 'cancelled', 'failure', 'new'].map(telnyxOrderStatus)).toEqual([
      'success',
      'cancelled',
      'cancelled',
      'failure',
      'pending',
    ])
  })

  test('a search with requirements is not refused for a country that needs documents; a plain one still is', async () => {
    const { provider, calls } = mockTelnyx(({ path }) => {
      if (path.startsWith('/regulatory_requirements'))
        return {
          json: {
            data: [
              { country_code: 'DE', regulatory_requirements: [{ id: 'r1', name: 'Address', field_type: 'address' }] },
            ],
          },
        }
      if (path.startsWith('/available_phone_numbers')) return { json: { data: [{ phone_number: NUMBER }] } }
    })
    await expect(provider.searchNumbers({ country: 'DE', areaCode: '30' })).rejects.toMatchObject({
      code: 'country_requirements',
    })
    expect(await provider.searchNumbers({ country: 'DE', areaCode: '30', withRequirements: true })).toEqual([
      { e164: NUMBER },
    ])
    expect(calls.at(-1)!.path).toContain('filter[national_destination_code]=30')
  })
})

describe('dev regulatory numbers', () => {
  afterEach(() => vi.unstubAllEnvs())

  test('hands out numbers of the country and keeps an order pending until the review is decided', async () => {
    const regulatory = devProvider.regulatory!
    const [found] = await devProvider.searchNumbers({ country: 'DE', areaCode: '30', limit: 1, withRequirements: true })
    expect(found!.e164).toBe('+49305550000')
    expect((await regulatory.numberRequirements('DE', 'local')).map(r => r.kind)).toContain('document')
    expect(await regulatory.numberRequirements('US', 'local')).toEqual([])
    const group = await regulatory.submitRequirementGroup({
      country: 'DE',
      type: 'local',
      customerReference: 'nr_x',
      values: [],
    })
    expect(group.status).toBe('pending_approval')
    const order = await regulatory.orderNumber({
      e164: found!.e164,
      requirementGroupRef: group.ref,
      customerReference: 'nr_x',
    })
    expect(order.status).toBe('pending')
    decideDevReview(order.ref, 'approved')
    expect(await regulatory.getNumberOrder(order.ref)).toMatchObject({
      status: 'success',
      number: { e164: found!.e164 },
    })
  })

  test('LINEDESK_DEV_KYC_OUTCOME decides a review nobody decided', async () => {
    const regulatory = devProvider.regulatory!
    const group = await regulatory.submitRequirementGroup({
      country: 'GB',
      type: 'local',
      customerReference: 'nr_y',
      values: [],
    })
    vi.stubEnv('LINEDESK_DEV_KYC_OUTCOME', 'declined')
    expect(await regulatory.getRequirementGroup(group.ref)).toMatchObject({ status: 'declined' })
    const order = await regulatory.orderNumber({
      e164: '+442055500001',
      requirementGroupRef: group.ref,
      customerReference: 'nr_y',
    })
    expect(order.status).toBe('failure')
  })
})
