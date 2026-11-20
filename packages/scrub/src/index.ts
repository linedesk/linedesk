// What may leave an install in an error report or a log line (Sentry, apps/*/error-reporting). One copy for the API,
// the voice agent and the web app. The member an error hit (id, email, name) is set on purpose and kept; everything
// else that could name a person or open something is cut or replaced: failed queries' parameters, email addresses,
// secrets (keys, passwords, signed links, enrolment codes) and phone numbers.

/** Our own ids stay readable, in exactly the shapes the code generates: a short prefix and 20 hex (call_19b8…, ps_…),
 * or llk_/fwc_/cmd_ and 32 hex. Anything else of that length (an sk_ key, a UUID-shaped secret) is a secret. */
const OWN_ID = /^(?:[a-z]{2,4}_[0-9a-f]{20}|(?:llk|fwc|cmd)_[0-9a-f]{32})$/

/** A secret-looking run: base64, base64url or hex of 24+ characters (an 18-byte code is 24). */
const TOKEN_RUN = /[A-Za-z0-9+/=_-]{24,}/g

/** A run with a digit (or base64 padding) is a secret; long plain words and snake_case names are not. */
const looksSecret = (run: string) => !OWN_ID.test(run) && /[\d+=]/.test(run)

function replaceToken(run: string): string {
  if (!run.includes('/')) return looksSecret(run) ? '[token]' : run
  // A path keeps its shape (/v1/calls/call_…/recording); a slash inside mixed-case base64 (S3 secret keys) does not.
  if (/[+=]/.test(run) || (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run))) return '[token]'
  return run
    .split('/')
    .map(segment => (segment.length >= 24 && looksSecret(segment) ? '[token]' : segment))
    .join('/')
}

/**
 * Phone numbers: international (+… and 00…), US (503) 555-0142, 503-555-0142, local 555-0142, national with a trunk 0
 * (German 06221 5550147, 06221/5550147, 030-1234567), and 10–15 bare digits.
 */
const PHONE =
  /\+\d[\d\s().-]{6,}\d|\b00[1-9][\d\s()/.-]{6,}\d|\b0\d{2,5}[\s/-]?\d{4,}\b|\(\d{3}\)\s?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{3}[.-]\d{4}\b|\b\d{10,15}\b/g

/** Phone numbers in a text, masked to their last two digits. */
export const maskPhoneNumbers = (text: string) =>
  text.replace(PHONE, number => `[phone …${number.replace(/\D/g, '').slice(-2)}]`)

/**
 * An error message or log line as it may leave the install. Drizzle appends "\nparams: <values>" to a failed query;
 * everything from there is cut, and a value Postgres quotes in its message is replaced. Then email addresses, secrets and phone numbers, in that order, so a long digit run
 * inside a token is never split into a "phone" and a shorter, surviving rest.
 */
/** Postgres errors that quote the rejected value: invalid input syntax/value, malformed literals, out-of-range dates. */
const QUOTED_PG_VALUE =
  /((?:invalid input syntax for type [\w ]+|invalid input value for enum [\w."]+|malformed [\w ]+ literal|date\/time field value out of range|time zone "[^"]*" not recognized|value too long for type [\w ()]+)\s*:?\s*)"(?:[^"\\]|\\.)*"/g

export const scrubText = (text: string) =>
  maskPhoneNumbers(
    (text.split(/(?:\\n|\n)params:/)[0] ?? '')
      .replace(QUOTED_PG_VALUE, '$1"[value]"')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      .replace(TOKEN_RUN, replaceToken),
  )

/** A path or URL without query, fragment, MCP setup key (/mcp/setup/<key>) or other secret-looking segment. */
export const scrubPath = (path: string) =>
  (path.split(/[?#]/)[0] ?? '')
    .replace(/\/mcp\/setup\/[^/]+/, '/mcp/setup/[key]')
    .split('/')
    .map(segment => (segment.length >= 24 && looksSecret(segment) ? '[key]' : segment))
    .join('/')

type ScrubbableEvent = {
  request?: { method?: string; url?: string }
  transaction?: string
  user?: { id?: string | number; email?: string; username?: string }
  exception?: { values?: { value?: string }[] }
  message?: string
  breadcrumbs?: unknown
  extra?: unknown
}

/** An error event: stack trace, scrubbed messages and the member (id, email, name); no request data, extra or breadcrumbs. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const e: ScrubbableEvent = event
  if (e.request) e.request = { method: e.request.method, url: e.request.url && scrubPath(e.request.url) }
  if (e.transaction) e.transaction = scrubPath(e.transaction)
  if (e.user) {
    const { id, email, username } = e.user
    e.user = { ...(id ? { id: String(id) } : {}), ...(email ? { email } : {}), ...(username ? { username } : {}) }
  }
  // Every exception, linked causes included, and the message.
  for (const exception of e.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value)
  }
  if (e.message) e.message = scrubText(e.message)
  delete e.breadcrumbs
  delete e.extra
  return event
}

/**
 * Log attributes that are kept: the SDK's own (origin, environment, release, the template) and the member. Dropped:
 * sentry.message.parameter.* (each console argument, an Error included, as JSON) and whatever a plain-object first
 * argument spread in.
 */
const KEPT_LOG_ATTRIBUTE = /^(?:sentry\.(?!message\.parameter\.)|user\.|server\.)/

/** Where the JSON value starting at `start` ends (exclusive); the text's end when it never closes. */
function jsonValueEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth++
    else if ((char === '}' || char === ']') && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * An Error the console integration turned into JSON becomes "Name: message"; any other object or array "[object]".
 * Only a real stack trace makes it an error: a contact has a name and a caller leaves a message.
 */
function summarizeJson(json: string): string {
  try {
    const value: unknown = JSON.parse(json)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const { name, message, stack } = value as Record<string, unknown>
      if (typeof message === 'string' && typeof stack === 'string' && /\n\s+at /.test(stack))
        return `${typeof name === 'string' ? name : 'Error'}: ${message}`
    }
  } catch {
    // Cut off or not JSON at all: nothing of it is kept.
  }
  return '[object]'
}

/**
 * The console integration writes every argument into the line, objects and errors as JSON: console.error('call
 * failed', { caller, transcript }) or a pg error with its "Failing row contains (…)" detail. Every top-level JSON
 * value in the line is replaced: an error by "Name: message" (its other fields, detail, params, cause, dropped), any
 * other object or array by "[object]".
 */
export function dropLoggedObjects(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '{' || char === '[') {
      const end = jsonValueEnd(text, i)
      const json = text.slice(i, end)
      out += json === '{}' ? json : summarizeJson(json) // {} is a log template's placeholder
      i = end
    } else {
      out += char
      i++
    }
  }
  return out
}

/** A log line: scrubbed message (no logged objects) and template, only the attributes above; the member (user.*, set by us) as is. */
export function scrubLog<T extends { message: unknown; attributes?: Record<string, unknown> }>(log: T): T {
  if (typeof log.message === 'string') log.message = scrubText(dropLoggedObjects(log.message))
  if (log.attributes) {
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(log.attributes)) {
      if (!KEPT_LOG_ATTRIBUTE.test(key)) continue
      kept[key] = typeof value === 'string' && !key.startsWith('user.') ? scrubText(dropLoggedObjects(value)) : value
    }
    log.attributes = kept
  }
  return log
}
