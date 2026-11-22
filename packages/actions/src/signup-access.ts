// Who may sign up in which country (Server admin › Billing › Sign-up › Sign-up countries; decisions of 2026-11-18): each country
// the install can serve has a sign-up mode, open to everyone, only invited email addresses, or off. The countries are
// the sign-up countries (SIGNUP_COUNTRIES: the US, Canada, Puerto Rico; open by default, so nothing changes for them)
// and the countries the server sells numbers in once an admin turned them on (Germany: Server admin › Phone
// numbers, apps/api/src/number-buy.ts), invited addresses only by default. One invite list serves every country set to "only invited". Each change is audited.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** Countries a sign-up may pick once the server sells numbers there (an admin turned them on). */
export const SIGNUP_ACCESS_COUNTRIES = ['DE'] as const
export type SignupAccessCountry = (typeof SIGNUP_ACCESS_COUNTRIES)[number]

/** How a country takes sign-ups: everyone, only the invited addresses, or nobody. */
export const SIGNUP_MODES = ['open', 'invited', 'off'] as const
export type SignupMode = (typeof SIGNUP_MODES)[number]

/** The most addresses the invite list holds (a list of businesses, not a mailing list). */
export const SIGNUP_ACCESS_INVITES_MAX = 500

/** An address as the invite list keeps it: trimmed, lower case. */
export const normalizeInviteEmail = (email: string) => email.trim().toLowerCase()

/** `data` of `signupAccess.get` and `.set`. */
export type SignupAccessData = {
  /** The countries this install can serve, in order, each with its sign-up mode and the mode it has by default. */
  countries: { country: string; mode: SignupMode; defaultMode: SignupMode }[]
  /** The addresses that may sign up in a country set to "only invited", lower case, sorted. */
  invites: string[]
}

export const signupAccessGet = defineAction({
  name: 'signupAccess.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'The countries a business can sign up in on this server, each with its sign-up mode (open to everyone, only invited email addresses, or off), and the invited addresses.',
  input: z.object({}).strict(),
  permission: 'instance:admin',
  readOnly: true,
})

export const signupAccessSet = defineAction({
  name: 'signupAccess.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Set the sign-up mode of countries (`modes`, by country code: open, invited or off; others keep theirs), or the invited addresses (`invites`, replaces the list). Only countries the server can serve are taken.',
  input: z
    .object({
      modes: z.record(z.string().regex(/^[A-Z]{2}$/), z.enum(SIGNUP_MODES)).optional(),
      invites: z.array(z.string().trim().email().max(200)).max(SIGNUP_ACCESS_INVITES_MAX).optional(),
    })
    .strict(),
  permission: 'instance:admin',
})
