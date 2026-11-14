// Error tracking with Sentry in the browser, only when the install sends a DSN (GET /v1/auth-methods,
// apps/api/src/error-reporting.ts). The SDK is loaded only then, so an install without it downloads nothing extra.
// Errors and console.warn/console.error lines, with the signed-in member (id, email, name), so we know whom an error
// hit. Never sent: tracing, session replay, sessions, breadcrumbs (they would carry what is on screen and in requests),
// the URL's query or fragment, request data, `extra`, console arguments as attributes. Messages and log lines are
// scrubbed by @linedesk/scrub (email addresses, secrets, phone numbers).
import { scrubEvent, scrubLog } from '@linedesk/scrub'

export type BrowserErrorReporting = { dsn: string; environment: string }
export type ReportedMember = { id: string; email?: string | null; name?: string | null }

type SentryModule = typeof import('@sentry/react')
let sentry: SentryModule | null = null
let member: ReportedMember | null = null

export async function startErrorReporting(config: BrowserErrorReporting | null | undefined): Promise<void> {
  if (!config?.dsn) return
  const Sentry = await import('@sentry/react')
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: import.meta.env.VITE_APP_BUILD,
    // Sentry 11 collects all of these by default; none of it may leave the install: no automatic user info (the member
    // is set by us), cookies, headers, bodies, query strings, local variable values, AI or MCP inputs and outputs.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // No tracing, and no trace headers on the app's own requests.
    tracePropagationTargets: [],
    maxBreadcrumbs: 0,
    integrations: integrations => [
      ...integrations.filter(i => i.name !== 'Breadcrumbs' && i.name !== 'BrowserSession'),
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    beforeSend: scrubEvent,
    beforeSendLog: scrubLog,
  })
  sentry = Sentry
  applyMember()
}

/**
 * The signed-in member errors are reported for; null after signing out. Called whenever the session changes
 * (shell/Nav.tsx, localData.ts), so signing in as someone else without a reload never reports under the old name.
 */
export function setReportedMember(next: ReportedMember | null): void {
  member = next
  applyMember()
}

function applyMember() {
  if (!sentry) return
  sentry.setUser(
    member
      ? {
          id: member.id,
          ...(member.email ? { email: member.email } : {}),
          ...(member.name ? { username: member.name } : {}),
        }
      : null,
  )
}
