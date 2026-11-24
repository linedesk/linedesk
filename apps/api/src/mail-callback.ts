// The OAuth callback of a mailbox connect: the provider redirects the member's browser here with `code` and `state`.
// It runs mail.connectFinish as the signed-in member and sends the browser back to Integrations › Gmail or › Outlook, with
// `mail=connected` or `mail=error&reason=<code>`: one of mailConnectErrors, which the page words. Never the provider's
// or the server's text: the page shows no server English, and nobody can put their own text there.
import { isMailConnectError, type MailConnectError, mailProvider } from '@linedesk/actions'
import { resolveActor } from './context.ts'
import { runAction } from './run-action.ts'

export async function mailCallback(
  providerParam: string,
  query: URLSearchParams,
  headers: Headers,
  webOrigin: string,
): Promise<string> {
  const provider = mailProvider.safeParse(providerParam)
  // Back to the provider's own card: Gmail or Outlook (the web app's support-email address goes to Gmail).
  const card = provider.success && provider.data === 'microsoft' ? 'outlook-mail' : 'gmail'
  const back = (params: Record<string, string>) =>
    `${new URL('/', webOrigin)}#integrations/${card}?${new URLSearchParams(params)}`
  const fail = (reason: MailConnectError) => back({ mail: 'error', reason })
  if (!provider.success) return fail('failed')
  // The member said no on the consent page, or the provider refused.
  if (query.get('error')) return fail(query.get('error') === 'access_denied' ? 'denied' : 'failed')
  const code = query.get('code')
  const state = query.get('state')
  if (!code || !state) return fail('failed')
  const actor = await resolveActor(headers)
  if (!actor) return fail('signed_out')
  const { body } = await runAction('mail.connectFinish', { provider: provider.data, state, code }, actor)
  if (!body.ok) {
    console.warn(`mail connect ${provider.data}: ${body.error}`)
    return fail(isMailConnectError(body.code) ? body.code : 'failed')
  }
  return back({ mail: 'connected' })
}
