// The last errors on this page, for a bug report (Help › Report a bug): console.error lines, uncaught errors and
// unhandled rejections, newest last. Kept in memory only, never sent on their own; the member sees them in the report
// and can leave them out. Scrubbed like Sentry's log lines (@linedesk/scrub: email addresses, secrets, phone numbers).
import { scrubText } from '@linedesk/scrub'

export type LoggedError = { at: string; text: string }

const MAX_ERRORS = 20
const MAX_LINE = 400
const errors: LoggedError[] = []
let started = false

/** What one console argument says: an error's message and first stack line, else its text. */
function describe(value: unknown): string {
  if (value instanceof Error) {
    const where = value.stack
      ?.split('\n')
      .find(line => line.trim().startsWith('at '))
      ?.trim()
    return where ? `${value.name}: ${value.message} (${where})` : `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function logError(...parts: unknown[]): void {
  const text = scrubText(parts.map(describe).join(' ')).slice(0, MAX_LINE)
  if (!text.trim()) return
  errors.push({ at: new Date().toISOString(), text })
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
}

/** Starts listening once, at app start (main.tsx), next to Sentry's own console capture (errorReporting.ts). */
export function startErrorLog(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    logError(...args)
    original(...args)
  }
  window.addEventListener('error', e => logError(e.error ?? e.message))
  window.addEventListener('unhandledrejection', e => logError('Unhandled rejection:', e.reason))
}

/** The errors so far, oldest first. */
export const recentErrors = (): LoggedError[] => [...errors]

/** The errors as one text for the report: one line each, with the time. */
export const errorsText = (list: LoggedError[]): string => list.map(e => `${e.at} ${e.text}`).join('\n')
