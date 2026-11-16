import {
  type AppConnector,
  AppError,
  type AppErrorKind,
  type AppOAuth,
  type FinishedCall,
  type Json,
  type OAuthClient,
  type OAuthTokens,
} from './types.ts'

/**
 * Slack (docs/crm-sync.md, "Slack"): not a CRM. Connecting installs the install's Slack app with the one scope
 * `incoming-webhook`; Slack's consent page lets the member pick the channel, and the token answer carries that
 * channel's incoming webhook. Every finished call is then one message, posted to that webhook. The bot token is kept
 * only to uninstall the app again on disconnect; it does not run out (unless the app turns on token rotation, then
 * it is refreshed like any other).
 */
export const SLACK_SCOPES = ['incoming-webhook'] as const

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
export const SLACK_API = 'https://slack.com/api'
/** Incoming webhooks are always on this host; any other URL in a token answer is refused. */
const WEBHOOK_PREFIX = 'https://hooks.slack.com/'
/** Slack's limits: a header holds 150 characters, a section 3000. */
const HEADER_MAX = 150
const SECTION_MAX = 3000

type Options = { fetch?: typeof fetch; timeoutMs?: number; api?: string }

/** Slack's own error codes (`error` of a Web API answer) that mean Slack is down, not that something is wrong. */
const PASSING = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])
/** Codes that mean the install's own app (client ID, secret) is wrong: Server admin's to fix. */
const CLIENT = new Set(['invalid_client_id', 'bad_client_secret'])

function apiKind(code: string): AppErrorKind {
  if (CLIENT.has(code)) return 'client'
  if (code === 'ratelimited') return 'rate_limited'
  if (PASSING.has(code)) return 'unavailable'
  return 'auth'
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** Seconds from a Retry-After header, when it holds a sane number. */
export function retryAfter(res: Response): number | undefined {
  const sec = Number(res.headers.get('retry-after'))
  return Number.isFinite(sec) && sec > 0 ? Math.min(Math.ceil(sec), 3600) : undefined
}

export function createSlackOAuth(
  { clientId, clientSecret }: OAuthClient,
  { fetch: doFetch = fetch, timeoutMs = 8000, api = SLACK_API }: Options = {},
): AppOAuth {
  /** One Web API method. Slack answers 200 with `ok: false` and a code for nearly every failure. */
  async function call(method: string, fields: Record<string, string>, what: string, bearer?: string): Promise<Json> {
    let res: Response
    try {
      res = await doFetch(`${api}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization: bearer ? `Bearer ${bearer}` : `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new AppError('slack', 'unavailable', `${what} could not reach Slack`)
    }
    if (res.status === 429) throw new AppError('slack', 'rate_limited', `${what}: rate limited`, 429, retryAfter(res))
    if (res.status >= 500) throw new AppError('slack', 'unavailable', `${what} failed`, res.status)
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Json
    if (body.ok !== true) {
      const code = text(body.error) ?? `HTTP ${res.status}`
      throw new AppError('slack', apiKind(code), `${what} failed: ${code.slice(0, 80)}`, res.status)
    }
    return body
  }

  function tokens(body: Json, what: string): OAuthTokens {
    const accessToken = text(body.access_token)
    if (!accessToken) throw new AppError('slack', 'invalid', `${what} returned no access token`)
    const expiresIn = Number(body.expires_in)
    const hook = (body.incoming_webhook ?? {}) as Json
    const url = text(hook.url)
    // An org-wide install (Enterprise Grid) names the organisation instead of a workspace.
    const team = (body.team ?? body.enterprise ?? {}) as Json
    const teamId = text(team.id)
    return {
      accessToken,
      refreshToken: text(body.refresh_token),
      expiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: text(body.scope),
      webhook: url?.startsWith(WEBHOOK_PREFIX) ? { url, channel: text(hook.channel) ?? '' } : null,
      account: teamId ? { id: teamId, name: text(team.name) ?? teamId } : null,
    }
  }

  return {
    id: 'slack',
    scopes: SLACK_SCOPES,
    grantPerAccount: true,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: clientId,
        scope: SLACK_SCOPES.join(','),
        redirect_uri: redirectUri,
        state,
      }).toString()
      return url.toString()
    },
    exchangeCode: async ({ code, redirectUri }) =>
      tokens(await call('oauth.v2.access', { code, redirect_uri: redirectUri }, 'connect'), 'connect'),
    // Only with token rotation turned on for the app; without it the token does not run out.
    refresh: async refreshToken =>
      tokens(
        await call('oauth.v2.access', { grant_type: 'refresh_token', refresh_token: refreshToken }, 'refresh access'),
        'refresh access',
      ),
    // Uninstalls the app from the workspace: the token and the incoming webhook stop working.
    async revoke(token) {
      try {
        await call('apps.uninstall', { client_id: clientId, client_secret: clientSecret }, 'uninstall', token)
        return true
      } catch {
        return false
      }
    },
    async account(accessToken) {
      const body = await call('auth.test', {}, 'reading the account', accessToken)
      const id = text(body.team_id) ?? text(body.enterprise_id)
      if (!id) throw new AppError('slack', 'invalid', 'reading the account returned no workspace')
      return { id, name: text(body.team) ?? id }
    },
  }
}

/** Text for mrkdwn: Slack reads only &, < and > as control characters. */
const mrkdwn = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/**
 * The message for a finished call (Block Kit): the title, an urgent line when urgent, caller and number, the summary,
 * the next steps, when it was (Slack writes the date in each reader's own zone and language; `labels.when` where it
 * cannot), and a button to the call in Linedesk. `text` is what notifications show.
 */
export function slackMessage(call: FinishedCall): { text: string; blocks: Json[] } {
  const { labels } = call
  const title = call.title.trim()
  const blocks: Json[] = [{ type: 'header', text: { type: 'plain_text', text: clip(title, HEADER_MAX), emoji: false } }]
  if (call.urgent)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:rotating_light: *${mrkdwn(labels.urgent)}*` } })
  const fields: Json[] = []
  if (call.caller.name?.trim())
    fields.push({ type: 'mrkdwn', text: `*${mrkdwn(labels.caller)}*\n${mrkdwn(call.caller.name.trim())}` })
  if (call.callerNumber)
    fields.push({ type: 'mrkdwn', text: `*${mrkdwn(labels.number)}*\n${mrkdwn(call.callerNumber)}` })
  if (fields.length) blocks.push({ type: 'section', fields })
  const summary = call.summary.trim()
  if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(mrkdwn(summary), SECTION_MAX) } })
  const steps = call.nextSteps.map(s => s.trim()).filter(Boolean)
  if (steps.length) {
    const list = steps.map(s => `• ${mrkdwn(s)}`).join('\n')
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: clip(`*${mrkdwn(labels.nextSteps)}*\n${list}`, SECTION_MAX) },
    })
  }
  const unix = Math.floor(Date.parse(call.startedAt) / 1000)
  if (Number.isFinite(unix))
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<!date^${unix}^{date_short_pretty} {time}|${mrkdwn(labels.when)}>` }],
    })
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: clip(labels.openCall, 75) },
        url: call.callUrl,
        action_id: 'open_call',
        style: 'primary',
      },
    ],
  })
  return { text: mrkdwn(call.urgent ? `${labels.urgent}: ${title}` : title), blocks }
}

/**
 * What an incoming webhook's answer means. Slack answers a refused post with a status and a code in plain text:
 * the channel deleted (`channel_not_found`) or archived (`channel_is_archived`), the app or webhook removed
 * (`invalid_token`, `no_service`, `no_team`, `team_disabled`, 404, 410), posting not allowed there
 * (`action_prohibited`, `posting_to_general_channel_denied`), a message Slack refused (`invalid_payload` …, 400).
 */
export function webhookError(status: number, body: string, retryAfterSec?: number): AppError {
  const code = body.trim().slice(0, 60)
  const fail = (kind: AppErrorKind) =>
    new AppError('slack', kind, `posting the call failed: ${code || status}`, status, retryAfterSec)
  if (status === 429) return fail('rate_limited')
  if (status >= 500) return fail('unavailable')
  if (code === 'channel_not_found') return fail('channel_not_found')
  if (code === 'channel_is_archived') return fail('channel_archived')
  if (status === 400 && !['no_service_id', 'no_team'].includes(code)) return fail('invalid')
  return fail('auth')
}

export function createSlackConnector({ fetch: doFetch = fetch, timeoutMs = 10_000 }: Options = {}): AppConnector {
  return {
    id: 'slack',
    crm: false,
    async pushCall(access, call, progress) {
      const url = access.webhookUrl ? await access.webhookUrl() : null
      if (!url?.startsWith(WEBHOOK_PREFIX)) throw new AppError('slack', 'auth', 'no incoming webhook: connect it again')
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(slackMessage(call)),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new AppError('slack', 'unavailable', 'posting the call could not reach Slack')
      }
      const body = await res.text().catch(() => '')
      if (!res.ok) throw webhookError(res.status, body, retryAfter(res))
      // A webhook message has no id at Slack: the call's own id marks it as posted, so a retry never posts it twice.
      await progress?.onLogged?.(call.callId)
      return { recordId: null, activityId: call.callId }
    },
  }
}
