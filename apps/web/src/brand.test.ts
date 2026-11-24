import { expect, test } from 'vitest'
import { tabIcon } from './brand.ts'

test("the tab shows the open workspace's icon, else the install logo, else the default mark", () => {
  const ws = '/v1/workspace-icons/ws1.png?v=1'
  const logo = '/v1/branding/logo.png?v=2'
  expect(tabIcon({ logoUrl: logo }, ws)).toEqual({ href: ws, type: 'image/png' })
  expect(tabIcon({ logoUrl: null }, ws)).toEqual({ href: ws, type: 'image/png' })
  expect(tabIcon({ logoUrl: logo }, null)).toEqual({ href: logo, type: 'image/png' })
  expect(tabIcon({ logoUrl: null }, null)).toEqual({ href: '/favicon.svg', type: 'image/svg+xml' })
})
