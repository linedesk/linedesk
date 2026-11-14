import { describe, expect, test } from 'vitest'
import { LOGO_MAX_BYTES } from './branding.ts'
import { redactInput, rolePermissions } from './define.ts'
import { actions } from './index.ts'
import { workspaceRemoveIcon, workspaceSetIcon } from './workspace-icon.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('workspace icon actions', () => {
  test('are registered, for owners and admins (settings:write), never for members or the agent', () => {
    expect(actions.get('workspace.setIcon')).toBe(workspaceSetIcon)
    expect(actions.get('workspace.removeIcon')).toBe(workspaceRemoveIcon)
    for (const def of [workspaceSetIcon, workspaceRemoveIcon]) {
      expect(def.permission).toBe('settings:write')
      expect(rolePermissions.owner).toContain(def.permission)
      expect(rolePermissions.admin).toContain(def.permission)
      expect(rolePermissions.member).not.toContain(def.permission)
      expect(rolePermissions.agent).not.toContain(def.permission)
    }
  })

  test('the icon is a PNG data URL of at most the logo size; SVG, JPEG and other text are refused', () => {
    expect(workspaceSetIcon.input.safeParse({ icon: PNG }).success).toBe(true)
    for (const icon of [
      'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
      'data:image/svg+xml,<svg onload="alert(1)"/>',
      'data:image/jpeg;base64,/9j/4AAQ',
      'https://example.com/logo.png',
      '',
    ])
      expect(workspaceSetIcon.input.safeParse({ icon }).success, icon).toBe(false)
    expect(workspaceSetIcon.input.safeParse({}).success).toBe(false)
    const tooLarge = `data:image/png;base64,${'A'.repeat(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4)}`
    expect(workspaceSetIcon.input.safeParse({ icon: tooLarge }).success).toBe(false)
    expect(workspaceRemoveIcon.input.safeParse({}).success).toBe(true)
  })

  test('the command log keeps that an icon was sent, not the image', () => {
    expect(JSON.stringify(redactInput(workspaceSetIcon, { icon: PNG }))).not.toContain('iVBOR')
  })
})
