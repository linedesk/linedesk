// Error tracking with Sentry for the voice agent, off unless SENTRY_DSN is set. The same options and scrubbing as the
// API (@linedesk/scrub/sentry-node). Started at module load, so the worker and every job process it starts for a call
// report their crashes.
import { serverSentryOptions } from '@linedesk/scrub/sentry-node'
import * as Sentry from '@sentry/node'

/** Starts Sentry for this process when SENTRY_DSN is set; true when it is on. */
export function initErrorReporting(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.SENTRY_DSN) return false
  Sentry.init(serverSentryOptions('agent', env))
  return true
}
