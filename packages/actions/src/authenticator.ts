// An instance admin's authenticator app (TOTP: Google Authenticator, 1Password, Authy …): the fallback to the passkey
// for Server admin (Tim's decisions 2026-11-15, LIN-275; apps/api/src/authenticator.ts), for an emergency or a computer
// without the passkey. A code from the app counts like a passkey check: 12 hours in that session. The passkey stays
// required: only an admin with one adds the app, after confirming with it.
import { z } from 'zod'
import { defineAction } from './define.ts'

const code = z.string().trim().min(6).max(12)

/** What account.authenticatorStart answers with: the secret to type in, or the address the QR code holds. */
export type AuthenticatorStartData = { secret: string; otpauthUrl: string }

export const accountAuthenticatorStart = defineAction({
  name: 'account.authenticatorStart',
  description:
    'Start adding an authenticator app, the fallback to your passkey for Server admin: answers with a new secret and its otpauth:// address (for the QR code). Needs a passkey and a session that passed the passkey check. Confirm with account.authenticatorConfirm.',
  input: z.object({}).strict(),
  permission: 'secondFactor:own',
  secretResult: ['secret', 'otpauthUrl'],
})

export const accountAuthenticatorConfirm = defineAction({
  name: 'account.authenticatorConfirm',
  description:
    'Finish adding the authenticator app with the first code it shows. The check counts for this session too. Only through POST /v1/account/authenticator/confirm.',
  input: z.object({ code }).strict(),
  permission: 'secondFactor:own',
  sensitive: ['code'],
})

export const accountAuthenticatorCheck = defineAction({
  name: 'account.authenticatorCheck',
  description:
    'Confirm Server admin with a code from your authenticator app, the fallback when your passkey is not at hand: counts for 12 hours in this session. Needs a passkey on the account. Only through POST /v1/account/authenticator/check.',
  input: z.object({ code }).strict(),
  permission: 'secondFactor:own',
  sensitive: ['code'],
})

export const accountAuthenticatorRemove = defineAction({
  name: 'account.authenticatorRemove',
  description: 'Remove your authenticator app. Needs a session that passed the passkey or authenticator check.',
  input: z.object({}).strict(),
  permission: 'secondFactor:own',
})

/** Wrong codes in a row before the app is locked for AUTHENTICATOR_LOCK_MINUTES. */
export const AUTHENTICATOR_MAX_FAILURES = 5
export const AUTHENTICATOR_LOCK_MINUTES = 15
