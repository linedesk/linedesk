import { expect, test } from 'vitest'
import { browserErrorReporting, initErrorReporting } from './error-reporting.ts'

// What actually goes on the wire is tested in packages/scrub/src/sentry-node.test.ts (it runs on every PR).

test('off without SENTRY_DSN: nothing starts and the browser gets no DSN', () => {
  expect(initErrorReporting('api', {})).toBe(false)
  expect(browserErrorReporting({})).toBeNull()
})

test('the browser gets its own DSN when one is set, else the shared one, with the environment', () => {
  expect(browserErrorReporting({ SENTRY_DSN: 'https://a@o1.ingest.us.sentry.io/1' })).toEqual({
    dsn: 'https://a@o1.ingest.us.sentry.io/1',
    environment: 'production',
  })
  expect(browserErrorReporting({ SENTRY_DSN: 'x', SENTRY_BROWSER_DSN: 'y', SENTRY_ENVIRONMENT: 'staging' })).toEqual({
    dsn: 'y',
    environment: 'staging',
  })
})
