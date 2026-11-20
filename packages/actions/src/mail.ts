import { z } from 'zod'
import { defineAction } from './define.ts'

// Support mailboxes (LIN-615): a business connects the mailbox its support answers from, read only, so Linedesk can
// learn the typical customer requests and how they are answered. Gmail and Microsoft 365 connect by OAuth:
// mail.connectStart returns the provider's consent URL; the provider sends the browser back to
// GET /v1/mail/callback/<provider>, which runs mail.connectFinish for the signed-in member. Connecting stores no mail.

export const mailProvider = z.enum(['google', 'microsoft'])
export type MailProviderId = z.infer<typeof mailProvider>

/**
 * Why connecting or disconnecting a mailbox did not work: the `reason` of the OAuth callback's redirect and the `code`
 * of the actions' rejections. The page words each one (an unknown code gets the generic text), so no server text
 * reaches the page and nobody can put their own text into the redirect.
 */
export const mailConnectErrors = [
  'denied',
  'signed_out',
  'expired',
  'other_workspace',
  'scope',
  'no_grant',
  'not_set_up',
  'no_secrets_key',
  'api_disabled',
  'app_refused',
  'account_refused',
  'unavailable',
  'not_connected',
  'failed',
] as const
export type MailConnectError = (typeof mailConnectErrors)[number]
export const isMailConnectError = (value: unknown): value is MailConnectError =>
  (mailConnectErrors as readonly unknown[]).includes(value)

export const mailConnectStart = defineAction({
  name: 'mail.connectStart',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Start connecting a support mailbox (Gmail or Microsoft 365) with read-only access. Returns the URL of the provider's consent page.",
  input: z.object({ provider: mailProvider }),
  permission: 'settings:write',
})

/** `data` of mail.connectStart. */
export type MailConnectStartData = { url: string }

export const mailConnectFinish = defineAction({
  name: 'mail.connectFinish',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Finish connecting a support mailbox with the code the provider sent back. Run by the OAuth callback route.',
  input: z.object({
    provider: mailProvider,
    state: z.string().min(16).max(200),
    code: z.string().min(1).max(4000),
  }),
  permission: 'settings:write',
  sensitive: ['code', 'state'],
})

/** `data` of mail.connectFinish. */
export type MailConnectFinishData = { connectionId: string }

export const mailDisconnect = defineAction({
  name: 'mail.disconnect',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Disconnect a support mailbox: its access is revoked at the provider where possible and its tokens deleted. Nothing in the mailbox changes.',
  input: z.object({ connectionId: z.string().min(1) }).strict(),
  permission: 'settings:write',
})

/** `data` of mail.disconnect: whether the provider withdrew the grant (Microsoft has no way to). */
export type MailDisconnectData = { revoked: boolean }
