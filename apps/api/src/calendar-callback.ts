// The OAuth callback of a calendar connect: the provider redirects the member's browser here with
// `code` and `state`. It runs calendar.connectFinish as the signed-in member and sends the browser
// back to the calendar settings, with `calendar=connected` or `calendar=error&reason=…`.
import { calendarProvider } from '@linedesk/actions'
import { resolveActor } from './context.ts'
import { runAction } from './run-action.ts'

const MAX_REASON = 200

export async function calendarCallback(providerParam: string, query: URLSearchParams, headers: Headers, webOrigin: string): Promise<string> {
  const back = (params: Record<string, string>) => `${new URL('/', webOrigin)}#assistant/calendar?${new URLSearchParams(params)}`
  const fail = (reason: string) => back({ calendar: 'error', reason: reason.slice(0, MAX_REASON) })
  const provider = calendarProvider.safeParse(providerParam)
  if (!provider.success) return fail('Unknown calendar provider.')
  // The member said no on the consent page, or the provider refused.
  if (query.get('error')) return fail(query.get('error') === 'access_denied' ? 'Access was not granted.' : 'The provider refused the connection.')
  const code = query.get('code')
  const state = query.get('state')
  if (!code || !state) return fail('The provider sent no code. Start again.')
  const actor = await resolveActor(headers)
  if (!actor) return fail('You were signed out. Sign in and start again.')
  const { body } = await runAction('calendar.connectFinish', { provider: provider.data, state, code }, actor)
  return body.ok ? back({ calendar: 'connected' }) : fail(body.error)
}
