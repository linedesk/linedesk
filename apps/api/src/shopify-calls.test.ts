import type { ShopifyOrder, ShopifyStore } from '@linedesk/connectors'
import { describe, expect, it } from 'vitest'
import {
  checkProof,
  nameQueries,
  orderView,
  phoneForSearch,
  productQueries,
  sameName,
  samePostcode,
  searchOrders,
} from './shopify-calls.ts'

const order = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-11-18T10:00:00Z',
  cancelledAt: null,
  financialStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  total: '89.00 USD',
  customer: { id: 'gid://shopify/Customer/7', name: 'Mike Brennan', email: 'mike@example.com', phone: '+15035550142' },
  email: 'mike@example.com',
  phone: null,
  shippingAddress: {
    name: 'Mike Brennan',
    address1: '12 Oak St',
    address2: null,
    city: 'Portland',
    province: 'Oregon',
    zip: '97205',
    country: 'United States',
    phone: null,
  },
  items: [{ title: 'Water heater valve', quantity: 1 }],
  shipments: [],
  ...over,
})

describe('checks before a change', () => {
  it('matches the family name, not a first name alone', () => {
    expect(sameName('Mike Brennan', order())).toBe(true)
    expect(sameName('michael brennan', order())).toBe(true)
    expect(sameName('Mike', order())).toBe(false)
    expect(sameName('Mike Smith', order())).toBe(false)
  })
  it('compares postcodes loosely', () => {
    expect(samePostcode('97205-1234', '97205')).toBe(true)
    expect(samePostcode('sw1a 1aa', 'SW1A1AA')).toBe(true)
    expect(samePostcode('97206', '97205')).toBe(false)
  })
  const caller = { number: '+15035550142', attested: true }
  it('asks for what is missing', () => {
    expect(checkProof(['verify_name', 'verify_postcode'], { name: 'Mike Brennan' }, order(), caller)).toEqual({
      missing: ['verify_postcode'],
      mismatch: false,
    })
  })
  it('passes when everything matches, fails when one does not', () => {
    expect(
      checkProof(['verify_name', 'verify_postcode'], { name: 'Mike Brennan', postcode: '97205' }, order(), caller),
    ).toEqual({ missing: [], mismatch: false })
    expect(
      checkProof(['verify_name', 'verify_postcode'], { name: 'Mike Brennan', postcode: '10001' }, order(), caller)
        .mismatch,
    ).toBe(true)
  })
  it('trusts the caller number only with full attestation', () => {
    expect(checkProof(['verify_caller_number'], {}, order(), caller).mismatch).toBe(false)
    expect(checkProof(['verify_caller_number'], {}, order(), { ...caller, attested: false }).mismatch).toBe(true)
    expect(checkProof(['verify_caller_number'], {}, order(), { number: '+15035550199', attested: true }).mismatch).toBe(
      true,
    )
  })
})

describe('finding orders', () => {
  const store = (orders: ShopifyOrder[], seen: string[] = []) =>
    ({
      findCustomers: async (_t: unknown, q: string) => (
        seen.push(`customers ${q}`), q.includes('+1503') ? [{ id: 'gid://shopify/Customer/7' }] : []
      ),
      findOrders: async (_t: unknown, q: string) => (seen.push(`orders ${q}`), orders),
    }) as unknown as ShopifyStore
  const token = async () => 'a.myshopify.com|t'
  it('searches by order number in both forms', async () => {
    const seen: string[] = []
    await searchOrders(store([order()], seen), token, { orderNumber: 'order 1001', status: 'unshipped' })
    expect(seen).toEqual([
      'orders (name:"#1001" OR name:"1001") AND fulfillment_status:unshipped AND -status:cancelled',
    ])
  })
  it('finds a phone number’s customer first', async () => {
    const seen: string[] = []
    await searchOrders(store([order()], seen), token, { phone: '+15035550142' })
    expect(seen).toEqual(['customers phone:"+15035550142"', 'orders (customer_id:7)'])
  })
  it('narrows by postcode, and needs something besides it', async () => {
    const other = order({ name: '#1002', shippingAddress: { ...order().shippingAddress!, zip: '10001' } })
    expect(
      (await searchOrders(store([order(), other]), token, { name: 'Brennan', postcode: '97205' }))!.map(o => o.name),
    ).toEqual(['#1001'])
    expect(await searchOrders(store([order()]), token, { postcode: '97205' })).toBeNull()
  })
  it('quotes what the caller said', async () => {
    const seen: string[] = []
    await searchOrders(store([], seen), token, { name: 'O"Brien OR status:any' })
    expect(seen[0]).toBe('orders "O\\"Brien" AND "OR" AND "status:any"')
  })
  it('tries each detail alone when all together find nothing, the order number first', async () => {
    const seen: string[] = []
    const byNumber = {
      findCustomers: async () => [],
      findOrders: async (_t: unknown, q: string) => (
        seen.push(q), q.startsWith('(name:') && !q.includes('AND') ? [order()] : []
      ),
    } as unknown as ShopifyStore
    const found = await searchOrders(byNumber, token, { orderNumber: '1001', name: 'Mike Brenan' })
    expect(found!.map(o => o.name)).toEqual(['#1001'])
    expect(seen).toEqual(['(name:"#1001" OR name:"1001") AND "Mike" AND "Brenan"', '(name:"#1001" OR name:"1001")'])
  })
  it('falls back from the full name to the family name and its first letters', async () => {
    const seen: string[] = []
    await searchOrders(store([], seen), token, { name: 'Mike Brenan' })
    expect(seen).toEqual(['orders "Mike" AND "Brenan"', 'orders "Brenan"', 'orders bren*'])
  })
  it('searches at most six times for one lookup', async () => {
    const seen: string[] = []
    await searchOrders(store([], seen), token, {
      orderNumber: '1',
      email: 'a@example.com',
      phone: '+15035550142',
      name: 'Ann Lee Brennan',
    })
    expect(seen.filter(q => q.startsWith('orders')).length).toBeLessThanOrEqual(6)
  })
  it('finds no order for a phone number no customer has', async () => {
    expect(await searchOrders(store([order()]), token, { phone: '+19995550100' })).toEqual([])
  })
  it('shows an order in plain words', () => {
    const view = orderView(
      order({
        fulfillmentStatus: 'FULFILLED',
        shipments: [
          {
            status: 'IN_TRANSIT',
            carrier: 'UPS',
            tracking: '1Z9',
            trackingUrl: null,
            estimatedDelivery: '2026-11-22T00:00:00Z',
            deliveredAt: null,
          },
        ],
      }),
    )
    expect(view.status).toBe('shipped')
    expect(view.shipments).toEqual(['in transit, with UPS, tracking number 1Z9, expected 2026-11-22'])
    // Never the name, street or postcode: the checks before a change compare those.
    expect(view.shipTo).toBe('Portland, Oregon, United States')
    expect(view.customer).toBeNull()
  })
  it('says store states as plain words, not Shopify jargon', () => {
    expect(orderView(order({ fulfillmentStatus: 'UNFULFILLED', shipments: [] })).status).toBe('not shipped yet')
    expect(orderView(order({ fulfillmentStatus: 'PARTIALLY_FULFILLED', shipments: [] })).status).toBe('partly shipped')
    // A state Shopify adds later keeps its own words.
    expect(orderView(order({ fulfillmentStatus: 'NEW_STATE', shipments: [] })).status).toBe('new state')
  })
})

describe('productQueries', () => {
  it('tries what the caller said, then with the last words left out, at most three times', () => {
    expect(productQueries('Complete Snowboard Powder')).toEqual([
      'Complete Snowboard Powder',
      'Complete Snowboard',
      'Complete',
    ])
    expect(productQueries('the big red ski wax')).toEqual(['the big red ski wax', 'the big red ski', 'the big red'])
    expect(productQueries('  wax  ')).toEqual(['wax'])
  })

  it('never searches a single word shorter than three letters', () => {
    expect(productQueries('XL shirt')).toEqual(['XL shirt'])
    expect(productQueries('a')).toEqual(['a'])
  })
})

describe('phoneForSearch', () => {
  it('writes a number as the store keeps it', () => {
    expect(phoneForSearch('(503) 555-0118')).toBe('+15035550118')
    expect(phoneForSearch('503-555-0118', '+15035550142')).toBe('+15035550118')
    expect(phoneForSearch('1 503 555 0118')).toBe('+15035550118')
    expect(phoneForSearch('+1 (503) 555-0118')).toBe('+15035550118')
    expect(phoneForSearch('0049 151 2345678')).toBe('+491512345678')
  })
  it('keeps a number of another country as said', () => {
    expect(phoneForSearch('0151 2345678', '+4930123456')).toBe('01512345678')
    expect(phoneForSearch('no number')).toBeNull()
  })
})

describe('nameQueries', () => {
  it('searches every word, then the family name, then its first letters', () => {
    expect(nameQueries('Michael Brennan')).toEqual(['"Michael" AND "Brennan"', '"Brennan"', 'bren*'])
    expect(nameQueries('José Núñez')).toEqual(['"José" AND "Núñez"', '"Núñez"', 'nune*'])
    expect(nameQueries('Lee')).toEqual(['"Lee"'])
  })
})
