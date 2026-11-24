// shopify.changeOrder through the handler (LIN-666): one change per call, whichever change it is. The store is a
// fake: nothing reaches Shopify.
import { actions, rolePermissions } from '@linedesk/actions'
import type { ShopifyOrder, ShopifyStore } from '@linedesk/connectors'
import { app_connections, type Tx } from '@linedesk/db'
import { beforeAll, describe, expect, test } from 'vitest'
import type { AppServices } from '../src/app-connections.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runHandler } from '../src/handlers.ts'
import { createWorkspace, type Workspace } from './helpers.ts'

class Rollback extends Error {}
async function inRollback(body: (tx: Tx) => Promise<void>) {
  await db
    .transaction(async tx => {
      await body(tx)
      throw new Rollback()
    })
    .catch(e => {
      if (!(e instanceof Rollback)) throw e
    })
}

const order = (name: string): ShopifyOrder => ({
  id: `gid://shopify/Order/${name.slice(1)}`,
  name,
  createdAt: '2026-11-20T10:00:00Z',
  cancelledAt: null,
  financialStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  total: '$699.95',
  customer: { id: 'gid://shopify/Customer/1', name: 'Mike Brennan', email: 'mike@example.com', phone: null },
  email: 'mike@example.com',
  phone: null,
  shippingAddress: {
    name: 'Mike Brennan',
    address1: '2240 NW Lovejoy St',
    address2: null,
    city: 'Portland',
    province: 'Oregon',
    zip: '97210',
    country: 'United States',
    phone: null,
  },
  items: [{ title: 'The Complete Snowboard', quantity: 1 }],
  shipments: [],
})

function fakeStore() {
  const done: string[] = []
  const orders = [order('#1002'), order('#1003')]
  const store = {
    findOrders: async (_token: unknown, query: string) => orders.filter(o => query.includes(o.name.slice(1))),
    updateShippingAddress: async (_token: unknown, id: string) => void done.push(`address ${id}`),
    cancelOrder: async (_token: unknown, id: string) => void done.push(`cancel ${id}`),
  } as unknown as ShopifyStore
  const services: AppServices = { oauth: async () => null, connector: () => ({}) as never, shopify: () => store }
  return { services, done }
}

let ws: Workspace
let agent: Actor
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  agent = { actorId: 'agent', role: 'agent', workspaceId: ws.id, permissions: rolePermissions.agent }
})

const change = (tx: Tx, services: AppServices, input: Record<string, unknown>) =>
  runHandler(
    { tx, actor: agent, now: new Date().toISOString(), apps: services, onRollback: () => {}, onCommit: () => {} },
    actions.get('shopify.changeOrder')!,
    actions.get('shopify.changeOrder')!.input.parse({
      callId: ws.call.id,
      proof: { name: 'Mike Brennan', postcode: '97210' },
      ...input,
    }),
  )

describe('shopify.changeOrder', () => {
  test('makes one change per call: after a new address, a cancellation on the same call is refused', async () => {
    const { services, done } = fakeStore()
    await inRollback(async tx => {
      await tx.insert(app_connections).values({
        id: 'appc_shop_test',
        workspace_id: ws.id,
        provider: 'shopify',
        account_id: 'brightwater.myshopify.com',
        account_name: 'Brightwater Supply',
        connected_by: ws.owner.userId,
        settings: { shop_address: true, shop_cancel: true },
      })
      const first = await change(tx, services, {
        orderNumber: '#1002',
        change: 'address',
        address: { address1: '100 SW Main St', city: 'Portland', zip: '97204' },
      })
      expect(first.data).toEqual({ status: 'done', detail: null })
      const second = await change(tx, services, { orderNumber: '#1003', change: 'cancel' })
      expect(second.data).toEqual({ status: 'not_allowed', detail: 'one change per call' })
      expect(done).toEqual(['address gid://shopify/Order/1002'])
    })
  })
})
