import { describe, expect, it } from 'vitest'
import { APP_SETTINGS, appSettingIds, appSettingOn, appUpdateSettings, connectableApps } from './apps.ts'
import { rolePermissions } from './define.ts'
import { applyLocally, type LocalTables } from './index.ts'

describe('app.updateSettings (LIN-367)', () => {
  it('every switch is on until a member turns it off, except only urgent calls', () => {
    for (const id of appSettingIds.filter(id => id !== 'only_urgent')) {
      expect(appSettingOn({}, id)).toBe(true)
      expect(appSettingOn(null, id)).toBe(true)
      expect(appSettingOn({ [id]: false }, id)).toBe(false)
    }
    expect(appSettingOn({}, 'only_urgent')).toBe(false)
    expect(appSettingOn(null, 'only_urgent')).toBe(false)
    expect(appSettingOn({ only_urgent: true }, 'only_urgent')).toBe(true)
    for (const app of connectableApps) expect(APP_SETTINGS[app].length).toBeGreaterThan(0)
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
