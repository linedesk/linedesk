// The OAuth callback of an app connect (HubSpot): the app redirects the member's browser here with `code` and
// `state`. It runs app.connectFinish as the signed-in member and sends the browser back to the app's page under
// Integrations, with `app=connected` or `app=error&reason=<code>`: one of appConnectErrors, which the page words.
// Never the app's or the server's text: the page shows no server English, and nobody can put their own text there.
import { type AppConnectError, connectableApps, isAppConnectError } from '@linedesk/actions'
import { z } from 'zod'
import { resolveActor } from './context.ts'
import { runAction } from './run-action.ts'

const appParam = z.enum(connectableApps)

export async function appCallback(
  appName: string,
  query: URLSearchParams,
  headers: Headers,
  webOrigin: string,
): Promise<string> {
  const app = appParam.safeParse(appName)
  const back = (params: Record<string, string>) =>
    `${new URL('/', webOrigin)}#integrations/${app.success ? app.data : ''}?${new URLSearchParams(params)}`
  const fail = (reason: AppConnectError) => back({ app: 'error', reason })
  if (!app.success) return fail('failed')
  // The member said no on the consent page, or the app refused.
  if (query.get('error')) return fail(query.get('error') === 'access_denied' ? 'denied' : 'failed')
  const code = query.get('code')
  const state = query.get('state')
  if (!code || !state) return fail('failed')
  const actor = await resolveActor(headers)
  if (!actor) return fail('signed_out')
  const { body } = await runAction('app.connectFinish', { app: app.data, state, code }, actor)
  if (!body.ok) {
    console.warn(`app connect ${app.data}: ${body.error}`)
    return fail(isAppConnectError(body.code) ? body.code : 'failed')
  }
  return back({ app: 'connected' })
}
