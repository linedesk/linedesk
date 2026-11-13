import { expect, test } from 'vitest'
import { permissionText } from './notificationPermission.ts'

test('the permission row says what the permission is for, and how to undo a block', () => {
  expect(permissionText('default')).toMatch(/browser and push notifications/)
  expect(permissionText('denied')).toMatch(/site settings, then reload/)
  expect(permissionText('granted')).toBe('This browser may show notifications.')
  expect(permissionText('ios-needs-install')).toMatch(/Home Screen/)
})
