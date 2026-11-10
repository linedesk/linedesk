import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { notificationsGet, notificationsSetDefaults, notificationsUpdate } from './notifications.ts'

describe('notifications actions', () => {
  it('every member reads and changes their own; only owners and admins set the defaults; the agent does neither', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(rolePermissions[role]).toContain(notificationsGet.permission)
      expect(rolePermissions[role]).toContain(notificationsUpdate.permission)
    }
    expect(rolePermissions.member).not.toContain(notificationsSetDefaults.permission)
    expect(rolePermissions.admin).toContain(notificationsSetDefaults.permission)
    expect(rolePermissions.agent).not.toContain(notificationsUpdate.permission)
  })

  it('own settings take true, false or null (back to the default); defaults only true or false', () => {
    expect(notificationsUpdate.input.safeParse({ email: null, browser: true }).success).toBe(true)
    expect(notificationsUpdate.input.safeParse({ email: 'yes' }).success).toBe(false)
    expect(notificationsSetDefaults.input.safeParse({ email: null }).success).toBe(false)
    expect(notificationsUpdate.patch).toBeUndefined()
  })
})
