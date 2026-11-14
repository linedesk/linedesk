// Error tracking with Sentry, off unless SENTRY_DSN is set (a self-hosted install sends nothing anywhere).
// Errors and warning/error log lines, with the member an error happened for (id, email, name), so we know whom it hit.
// Never sent: tracing, breadcrumbs, request bodies, cookies, headers, query strings, local variables, `extra`, console
// arguments or logged objects. Options and scrubbing: @linedesk/scrub (sentry-node.ts, index.ts), shared with the agent.
import { serverSentryOptions } from '@linedesk/scrub/sentry-node'
import * as Sentry from '@sentry/node'

type Env = Record<string, string | undefined>

let enabled = false

/** Starts Sentry for this process when SENTRY_DSN is set; true when it is on. */
export function initErrorReporting(service: 'api', env: Env = process.env): boolean {
  if (!env.SENTRY_DSN) return false
  Sentry.init(serverSentryOptions(service, env))
  enabled = true
  return true
}

export type ReportedUser = { id: string; email?: string | null; name?: string | null; workspaceId?: string | null }

/** Reports an error the code handled itself (e.g. the API's 500 handler), with the member it happened for; a no-op while Sentry is off. */
export function reportError(error: unknown, user?: ReportedUser | null): void {
  if (!enabled) return
  Sentry.withScope(scope => {
    if (user) {
      scope.setUser({
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
        ...(user.name ? { username: user.name } : {}),
      })
      if (user.workspaceId) scope.setTag('workspace', user.workspaceId)
    }
    Sentry.captureException(error)
  })
}

/** Whether errors are reported, so a caller can skip work (a lookup) that only serves the report. */
export const errorReportingEnabled = () => enabled

/** What the web app needs to report its own errors: the DSN (public by design) and the environment, or null. */
export function browserErrorReporting(env: Env = process.env): { dsn: string; environment: string } | null {
  const dsn = env.SENTRY_BROWSER_DSN || env.SENTRY_DSN
  return dsn ? { dsn, environment: env.SENTRY_ENVIRONMENT || 'production' } : null
}
