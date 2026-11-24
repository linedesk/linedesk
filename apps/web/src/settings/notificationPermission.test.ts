import { expect, test } from 'vitest'
import { permissionText } from './notificationPermission.ts'

test('the permission text says what the permission is for, and how to undo a block', () => {
  expect(permissionText('default')).toMatch(/asks once/)
  expect(permissionText('denied')).toMatch(/site settings, then reload/)
  expect(permissionText('granted')).toBe('This browser may show notifications.')
  expect(permissionText('ios-needs-install')).toMatch(/Home Screen/)
})
