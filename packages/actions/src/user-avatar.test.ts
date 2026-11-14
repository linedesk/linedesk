import { describe, expect, test } from 'vitest'
import { LOGO_MAX_BYTES } from './branding.ts'
import { redactInput, rolePermissions } from './define.ts'
import { actions } from './index.ts'
import { accountRemoveAvatar, accountSetAvatar, avatarUrlOf } from './user-avatar.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('profile picture actions', () => {
  test('are registered, for every team role, never for the voice agent', () => {
    expect(actions.get('account.setAvatar')).toBe(accountSetAvatar)
    expect(actions.get('account.removeAvatar')).toBe(accountRemoveAvatar)
    for (const def of [accountSetAvatar, accountRemoveAvatar]) {
      for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain(def.permission)
      expect(rolePermissions.agent).not.toContain(def.permission)
      expect(def.agent).toBeFalsy()
    }
  })

  test('the picture is a PNG data URL of at most the logo size; SVG, JPEG and other text are refused', () => {
    expect(accountSetAvatar.input.safeParse({ avatar: PNG }).success).toBe(true)
    for (const avatar of [
      'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
      'data:image/svg+xml,<svg onload="alert(1)"/>',
      'data:image/jpeg;base64,/9j/4AAQ',
      'https://example.com/me.png',
      '',
    ])
      expect(accountSetAvatar.input.safeParse({ avatar }).success, avatar).toBe(false)
    const tooLarge = `data:image/png;base64,${'A'.repeat(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4)}`
    expect(accountSetAvatar.input.safeParse({ avatar: tooLarge }).success).toBe(false)
    expect(accountRemoveAvatar.input.safeParse({}).success).toBe(true)
  })

  test('the command log keeps that a picture was sent, not the image', () => {
    expect(JSON.stringify(redactInput(accountSetAvatar, { avatar: PNG }))).not.toContain('iVBOR')
  })

  test('the address changes with the version; no version, no address', () => {
    expect(avatarUrlOf('u 1', 'ab12')).toBe('/v1/avatars/u%201.png?v=ab12')
    expect(avatarUrlOf('u1', null)).toBeNull()
  })
})
