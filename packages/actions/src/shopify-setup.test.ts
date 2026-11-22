import { describe, expect, test } from 'vitest'
import { isShopifyInstallUrl, shopHandle } from './shopify-setup.ts'

const SHOP = 'brightwater.myshopify.com'
const ID = 'a1b2c3d4e5f6'
const url = `https://admin.shopify.com/store/brightwater/oauth/install_custom_app?client_id=${ID}&no_redirect=true`

describe("Shopify's install link of a store's own app", () => {
  test('the store handle is the part before .myshopify.com', () => {
    expect(shopHandle(SHOP)).toBe('brightwater')
  })

  test('the link for this store and this app, more parameters allowed', () => {
    expect(isShopifyInstallUrl(url, SHOP, ID)).toBe(true)
    expect(
      isShopifyInstallUrl(
        `https://admin.shopify.com/store/brightwater/oauth/install_custom_app?client_id=${ID}`,
        SHOP,
        ID,
      ),
    ).toBe(true)
  })

  test.each([
    ['another store', url.replace('/store/brightwater/', '/store/brightwater2/')],
    ['another app', url.replace(ID, 'other')],
    ['two client ids', `${url}&client_id=${ID}`],
    ['http', url.replace('https:', 'http:')],
    ['another host', url.replace('admin.shopify.com', 'evil.test')],
    ['a port', url.replace('admin.shopify.com', 'admin.shopify.com:8443')],
    ['a user', url.replace('https://', 'https://me@')],
    ['another path', url.replace('/oauth/install_custom_app', '/apps')],
    ['no URL', 'brightwater'],
  ])('not for %s', (_what, link) => {
    expect(isShopifyInstallUrl(link, SHOP, ID)).toBe(false)
  })
})
