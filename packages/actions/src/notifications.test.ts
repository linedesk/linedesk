import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import {
  isPushServiceUrl,
  notificationsGet,
  notificationsSetDefaults,
  notificationsUpdate,
  pushDeviceId,
  pushSubscribe,
  pushUnsubscribe,
} from './notifications.ts'

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

  it('push: every member subscribes their own browser; endpoint and keys are sensitive; https only', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(rolePermissions[role]).toContain(pushSubscribe.permission)
      expect(rolePermissions[role]).toContain(pushUnsubscribe.permission)
    }
    expect(rolePermissions.agent).not.toContain(pushSubscribe.permission)
    expect(pushSubscribe.sensitive).toEqual(['endpoint', 'keys'])
    expect(pushUnsubscribe.sensitive).toEqual(['endpoint'])
    const keys = { p256dh: 'p', auth: 'a' }
    expect(pushSubscribe.input.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys }).success).toBe(
      true,
    )
    expect(pushSubscribe.input.safeParse({ endpoint: 'http://fcm.googleapis.com/fcm/send/1', keys }).success).toBe(
      false,
    )
    expect(pushSubscribe.input.safeParse({ endpoint: 'https://push.example.com/1', keys }).success).toBe(false)
    expect(pushUnsubscribe.input.safeParse({ endpoint: 'https://fcm.googleapis.com.evil.example/1' }).success).toBe(
      false,
    )
    for (const ok of [
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://db5.notify.windows.com/w/x',
    ])
      expect(isPushServiceUrl(ok), ok).toBe(true)
    for (const bad of [
      'https://push.apple.com.evil.example/x',
      'https://notpush.apple.com/x',
      'https://fcm.googleapis.com:444/x',
      'https://a:b@fcm.googleapis.com/x',
      'not a url',
    ])
      expect(isPushServiceUrl(bad), bad).toBe(false)
    expect(pushSubscribe.patch).toBeUndefined()
    const id = await pushDeviceId('https://push.example.com/1')
    expect(id).toMatch(/^[0-9a-f]{24}$/)
    expect(await pushDeviceId('https://push.example.com/2')).not.toBe(id)
  })
})
