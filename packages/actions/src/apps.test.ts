import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS,
  appSettingIds,
  appSettingOn,
  appUpdateSettings,
  connectableApps,
  isShopifyRecommended,
  SHOPIFY_RECOMMENDED,
  shopifyRecommendedSettings,
} from './apps.ts'
import { rolePermissions } from './define.ts'
import { applyLocally, type LocalTables } from './index.ts'

describe('app.updateSettings (LIN-367)', () => {
  it('every switch is on until a member turns it off, except the ones that change more or ask more', () => {
    const off = [
      'only_urgent',
      'shop_returns',
      'shop_address',
      'shop_cancel',
      'verify_email',
      'verify_order_number',
      'verify_caller_number',
    ]
    for (const id of appSettingIds) {
      const byDefault = !off.includes(id)
      expect(appSettingOn({}, id)).toBe(byDefault)
      expect(appSettingOn(null, id)).toBe(byDefault)
      expect(appSettingOn({ [id]: !byDefault }, id)).toBe(!byDefault)
    }
    // Shopify adds no new caller as a customer until the business turns it on.
    expect(appSettingOn({}, 'create_contacts', 'shopify')).toBe(false)
    expect(appSettingOn({}, 'create_contacts', 'hubspot')).toBe(true)
    expect(appSettingOn({ create_contacts: true }, 'create_contacts', 'shopify')).toBe(true)
    for (const app of connectableApps) expect(APP_SETTINGS[app].length).toBeGreaterThan(0)
  })

  it('starts a Shopify connection with the recommended setup', () => {
    for (const id of APP_SETTINGS.shopify) expect(appSettingOn({}, id, 'shopify')).toBe(SHOPIFY_RECOMMENDED[id])
    expect(appSettingOn({}, 'shop_returns', 'shopify')).toBe(true)
    expect(appSettingOn({}, 'shop_cancel', 'shopify')).toBe(false)
    expect(isShopifyRecommended({})).toBe(true)
    expect(isShopifyRecommended({ shop_cancel: true })).toBe(false)
    expect(isShopifyRecommended({ shop_cancel: false, log_calls: true })).toBe(true)
  })

  it('sets the recommended Shopify setup with only the switches Shopify has', () => {
    expect(Object.keys(shopifyRecommendedSettings()).sort()).toEqual([...APP_SETTINGS.shopify].sort())
    expect(appUpdateSettings.input.safeParse({ id: 'appc_1', settings: shopifyRecommendedSettings() }).success).toBe(
      true,
    )
  })

  it('is applied to the connection locally at once', () => {
    const row = { id: 'appc_1', provider: 'hubspot', settings: {} }
    const local = { app_connections: new Map([['appc_1', row]]) } as unknown as LocalTables
    const settings = { log_calls: true, create_contacts: false, fill_fields: true }
    applyLocally(local, appUpdateSettings, { id: 'appc_1', settings }, '2026-11-16T12:00:00.000Z')
    expect(local.app_connections.get('appc_1')).toMatchObject({ provider: 'hubspot', settings })
  })

  it('Slack has posting every call and only urgent calls (LIN-351)', () => {
    expect(APP_SETTINGS.slack).toEqual(['log_calls', 'only_urgent'])
    const row = { id: 'appc_2', provider: 'slack', settings: {} }
    const local = { app_connections: new Map([['appc_2', row]]) } as unknown as LocalTables
    const settings = { log_calls: true, only_urgent: true }
    applyLocally(local, appUpdateSettings, { id: 'appc_2', settings }, '2026-11-16T12:00:00.000Z')
    expect(local.app_connections.get('appc_2')).toMatchObject({ provider: 'slack', settings })
  })

  it('Jobber has the CRM switches: a note on the client, new callers as clients, empty fields (LIN-304)', () => {
    expect(APP_SETTINGS.jobber).toEqual(['log_calls', 'create_contacts', 'fill_fields'])
  })

  it('takes only known switches, each true or false', () => {
    const parse = (settings: unknown) => appUpdateSettings.input.safeParse({ id: 'appc_1', settings }).success
    expect(parse({ create_contacts: false })).toBe(true)
    expect(parse({})).toBe(true)
    expect(parse({ create_contacts: 'no' })).toBe(false)
    expect(parse({ delete_contacts: true })).toBe(false)
  })

  it('needs settings:write: owners and admins, not members or the agent', () => {
    expect(appUpdateSettings.permission).toBe('settings:write')
    expect(appUpdateSettings.readOnly).toBeUndefined()
    expect(rolePermissions.owner).toContain('settings:write')
    expect(rolePermissions.admin).toContain('settings:write')
    expect(rolePermissions.member).not.toContain('settings:write')
    expect(rolePermissions.agent).not.toContain('settings:write')
  })
})
