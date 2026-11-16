import { z } from 'zod'
import { defineAction } from './define.ts'

// OAuth sign-in for MCP clients (LIN-126, docs/api.md): Claude, ChatGPT, Claude Code, Cursor, VS Code and others connect
// with the server address alone. GET /oauth/authorize sends the person to the consent page in the app
// (#connect-agent?<the request>); Allow (oauth.approve) gives the client a single-use code, which the token endpoint
// turns into a personal API key for that client. The key is listed and revoked with the person's other keys.

/** The hash route of the consent page; the authorization request follows as its query. */
export const OAUTH_CONSENT_HASH = '#connect-agent'

/** The authorization request as the client sent it (RFC 6749 4.1.1, PKCE RFC 7636, resource RFC 8707). */
export const oauthRequestInput = z.object({
  client_id: z.string().min(1).max(2000),
  redirect_uri: z.string().min(1).max(2000),
  response_type: z.string().max(50).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
  scope: z.string().max(2000).optional(),
})
export type OAuthRequest = z.infer<typeof oauthRequestInput>

/** Why a request cannot be approved; the consent page shows a text for each. */
export const OAUTH_PROBLEMS = [
  'client',
  'redirect',
  'response_type',
  'pkce',
  'resource',
  'metadata_unreachable',
] as const
export type OAuthProblem = (typeof OAUTH_PROBLEMS)[number]

/**
 * Where the client gets the answer, so a fake name can be caught: `web` an https site (host), `loopback` a program on
 * this computer (port), `app` an app opened by its link scheme (`cursor`, `vscode`).
 */
export type OAuthRedirectKind = 'web' | 'loopback' | 'app'

export type OAuthDescribeData =
  | {
      ok: true
      clientName: string
      /** The host of the client's metadata document URL, when the client is known by one (the site publishing it). */
      clientHost: string | null
      redirect: { kind: OAuthRedirectKind; where: string }
      /** The account the client will act as. */
      email: string
      /** Where Cancel goes: the client's redirect URI with error=access_denied. */
      denyTo: string
    }
  | {
      ok: false
      problem: OAuthProblem
      /**
       * The client's redirect URI with the error, when the client and redirect URI are known good: the page offers it
       * as a button, never as an automatic redirect. Null when the error must stay here.
       */
      errorTo: string | null
    }

export const oauthDescribe = defineAction({
  name: 'oauth.describe',
  description:
    'What the consent page shows for an MCP client asking to connect: its name and where it sends the answer.',
  input: oauthRequestInput,
  permission: 'account:own',
  readOnly: true,
})

/** `data` of oauth.approve: the client's redirect URI with the code, state and issuer. */
export type OAuthApproveData = { redirectTo: string }

export const oauthApprove = defineAction({
  name: 'oauth.approve',
  description:
    'Allow an MCP client to act as you: returns the address that gives it a single-use code for a personal API key.',
  input: oauthRequestInput,
  permission: 'account:own',
  // The code in redirectTo is a way to a key until it is used: never in the command log.
  secretResult: true,
})
