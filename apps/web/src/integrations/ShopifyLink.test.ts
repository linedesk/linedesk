import { describe, expect, it } from 'vitest'
import {
  forgetShopifyLink,
  isShopifyLinkHash,
  pendingShopifyLink,
  rememberShopifyLink,
  shopifyLinkHash,
  shopifyLinkToken,
} from './ShopifyLink.tsx'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: k => void map.delete(k),
    clear: () => map.clear(),
    key: i => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

const TOKEN = 'k'.repeat(43)

describe('the Shopify link page’s address', () => {
  it('reads the link’s token, and nothing that is not one', () => {
    expect(isShopifyLinkHash(`#shopify/link?t=${TOKEN}`)).toBe(true)
    expect(isShopifyLinkHash('#shopify/linked')).toBe(false)
    expect(shopifyLinkToken(shopifyLinkHash(TOKEN))).toBe(TOKEN)
    expect(shopifyLinkToken('#shopify/link?t=short')).toBeNull()
    expect(shopifyLinkToken(`#shopify/link?t=${TOKEN}%3Cscript`)).toBeNull()
    expect(shopifyLinkToken('#shopify/link')).toBeNull()
    expect(shopifyLinkToken(`#integrations/shopify?t=${TOKEN}`)).toBeNull()
  })
})

describe('the link kept in this tab', () => {
  it('lasts as long as the link itself, and is forgotten', () => {
    const storage = memoryStorage()
    rememberShopifyLink(TOKEN, 1_000, storage)
    expect(pendingShopifyLink(1_000 + 14 * 60_000, storage)).toBe(TOKEN)
    expect(pendingShopifyLink(1_000 + 15 * 60_000, storage)).toBeNull()
    forgetShopifyLink(storage)
    expect(pendingShopifyLink(1_000, storage)).toBeNull()
  })
  it('ignores what is not a kept link', () => {
    const storage = memoryStorage()
    storage.setItem('linedesk.shopifyLink', '{"token":"<x>","at":1}')
    expect(pendingShopifyLink(1, storage)).toBeNull()
    storage.setItem('linedesk.shopifyLink', 'not json')
    expect(pendingShopifyLink(1, storage)).toBeNull()
  })
})
