import { expect, test } from 'vitest'
import { canonicalAssistantHash } from './assistantLinks.ts'

const ids = ['as_1', 'as_2']

test('the old Webhook section opens Advanced at the webhook', () => {
  expect(canonicalAssistantHash('#assistant/as_2/webhooks', ids)).toBe('#assistant/as_2/advanced/webhook')
  expect(canonicalAssistantHash('#assistant/webhooks', ids)).toBe('#assistant/as_1/advanced/webhook')
  expect(canonicalAssistantHash('#assistant/as_1/webhooks?ws=w1', ids)).toBe('#assistant/as_1/advanced/webhook?ws=w1')
})

test('a link without an assistant keeps what follows the section', () => {
  expect(canonicalAssistantHash('#assistant/advanced/webhook', ids)).toBe('#assistant/as_1/advanced/webhook')
  expect(canonicalAssistantHash('#assistant/hours', ids)).toBe('#assistant/as_1/hours')
})

test('links that are already right stay as they are', () => {
  expect(canonicalAssistantHash('#assistant/as_1/advanced/webhook', ids)).toBeNull()
  expect(canonicalAssistantHash('#assistant/as_1/advanced', ids)).toBeNull()
  expect(canonicalAssistantHash('#assistant', ids)).toBeNull()
  expect(canonicalAssistantHash('#inbox', ids)).toBeNull()
})

test('old section ids and notifications', () => {
  expect(canonicalAssistantHash('#assistant/as_1/calendar', ids)).toBe('#assistant/as_1/booking')
  expect(canonicalAssistantHash('#assistant/as_1/notifications', ids)).toBe('#account/notifications')
})
