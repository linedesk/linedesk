// The Sentry options of the API and the voice agent (apps/api/src/error-reporting.ts, apps/agent/src/error-reporting.ts):
// what is collected and how it is scrubbed. The browser's are in apps/web/src/errorReporting.ts.
import * as Sentry from '@sentry/node'
import { scrubEvent, scrubLog } from './index.ts'

type Env = Record<string, string | undefined>

export function serverSentryOptions(service: 'api' | 'agent', env: Env): Sentry.NodeOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release: env.SENTRY_RELEASE || undefined,
    initialScope: { tags: { service } },
    // Sentry 11 collects all of these by default; none of it may leave the install (transcripts, what callers said,
    // phone numbers, tokens): no automatic user info (the member is set by us), cookies, headers, bodies, query
    // strings, local variable values, query or job data, and no AI or MCP inputs and outputs.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // No tracing at all (any tracesSampleRate, even 0, turns it on), and no trace headers on requests to carriers,
    // speech and AI providers, calendars or customer webhooks.
    tracePropagationTargets: [],
    // No runtime channel injection: module loader hooks (a thread, ~0.5 s of CPU at every start; LIN-569, LIN-638)
    // that add spans and breadcrumbs to modules as Node loads them. Both images run a bundle, where there are none to
    // hook, and no spans or breadcrumbs are sent.
    enableRuntimeChannelInjection: false,
    maxBreadcrumbs: 0,
    integrations: [
      // Logs: console.warn and console.error only (plain console.log can carry transcripts); scrubLog keeps the
      // scrubbed line, without the objects logged in it, and drops the arguments attached one by one.
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
      // No request-session aggregates.
      Sentry.httpIntegration({ sessions: false }),
    ],
    beforeSend: scrubEvent,
    beforeSendLog: scrubLog,
  }
}
