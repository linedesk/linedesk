import { expect, test } from 'vitest'
import { adminHash, parseAdminHash } from './route.ts'

test('admin hashes name a section and optionally a row', () => {
  expect(parseAdminHash('#admin')).toEqual({ section: 'workspaces', id: null })
  expect(parseAdminHash('#admin/users')).toEqual({ section: 'users', id: null })
  expect(parseAdminHash('#admin/users/u%2F1')).toEqual({ section: 'users', id: 'u/1' })
  expect(parseAdminHash('#admin/nothing/1')).toEqual({ section: 'workspaces', id: null })
  expect(adminHash({ section: 'users', id: 'u/1' })).toBe('#admin/users/u%2F1')
  expect(adminHash({ section: 'system', id: null })).toBe('#admin/system')
})
