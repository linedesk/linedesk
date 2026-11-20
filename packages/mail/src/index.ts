export { createGmail, createGmailOAuth, GMAIL_SCOPES, gmailBodyText } from './google.ts'
export { createGraphMail, createMicrosoftMailOAuth, MICROSOFT_MAIL_SCOPES } from './microsoft.ts'
export * from './provider.ts'

import { createGmail } from './google.ts'
import { createGraphMail } from './microsoft.ts'
import type { AccessTokenSource, MailProvider, MailProviderName } from './provider.ts'

/** The adapter for a connected mailbox. */
export function createMailProvider(
  name: MailProviderName,
  options: { accessToken: AccessTokenSource; accountEmail: string; fetch?: typeof fetch; timeoutMs?: number },
): MailProvider {
  return name === 'google' ? createGmail(options) : createGraphMail(options)
}
