import { scrubEvent, scrubText } from '@linedesk/scrub'
import type { ErrorEvent } from '@sentry/react'
import { expect, test } from 'vitest'

test('a browser error keeps its message and the member but loses the URL query and fragment and breadcrumbs', () => {
  const event = scrubEvent({
    type: undefined,
    exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] },
    request: { url: 'https://app.example.com/?call=call_1#contact/c_2', headers: { 'user-agent': 'x' } },
    user: { id: 'u_1', email: 'mike@example.com', username: 'Mike Brennan', ip_address: '1.2.3.4' },
    breadcrumbs: [{ message: 'clicked Mike Brennan' }],
  } as ErrorEvent)
  expect(event.exception?.values?.[0]?.value).toBe('x is undefined')
  expect(event.request).toEqual({ url: 'https://app.example.com/' })
  expect(event.user).toEqual({ id: 'u_1', email: 'mike@example.com', username: 'Mike Brennan' })
  expect(event.breadcrumbs).toBeUndefined()
})

test('a browser message loses phone numbers, email addresses and secrets', () => {
  expect(scrubText('could not text +15035550142 for mike@example.com with code Zk9_q3TbW0aRx1mN4pLs8vYc')).toBe(
    'could not text [phone …42] for [email] with code [token]',
  )
})
