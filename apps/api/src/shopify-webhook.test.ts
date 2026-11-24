import { describe, expect, it } from 'vitest'
import { redactedCustomerIds, shopOf } from './shopify-webhook.ts'

describe('Shopify webhook bodies', () => {
  it('take the store from the signed body', () => {
    expect(shopOf({ shop_domain: 'brightwater.myshopify.com' })).toBe('brightwater.myshopify.com')
    expect(shopOf({ myshopify_domain: 'brightwater.myshopify.com', domain: 'shop.example.com' })).toBe(
      'brightwater.myshopify.com',
    )
    expect(shopOf({ domain: 'evil.example.com' })).toBeNull()
    expect(shopOf(null)).toBeNull()
  })
  it('read the customer to forget', () => {
    expect(redactedCustomerIds({ customer: { id: 191167 } })).toEqual(['gid://shopify/Customer/191167'])
    expect(redactedCustomerIds({ customer: { id: 'x' } })).toEqual([])
  })
})
