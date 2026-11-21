// Who may sign up in which country (packages/actions/src/signup-access.ts, decisions of 2026-11-18). The countries an
// install can serve: the sign-up countries (SIGNUP_COUNTRIES, open by default) and SIGNUP_ACCESS_COUNTRIES (Germany,
// only invited addresses by default). Whether German numbers can be bought yet does not change who may sign up
// (number-buy.ts: until then German workspaces read that numbers are being set up). Each has a mode,
// open / only invited / off, set by a server admin (Server admin › Sign-up); one invite list serves every country set
// to "only invited". Both are instance settings; an install that sets nothing behaves as before. The mode gates new
// choices of a country (sign-up, the Business step, Workspace settings, Checkout; served-countries.ts).
import {
  normalizeInviteEmail,
  SIGNUP_ACCESS_COUNTRIES,
  SIGNUP_MODES,
  type SignupAccessData,
  type SignupMode,
} from '@linedesk/actions'
import { instance_settings, SIGNUP_COUNTRIES, type Tx } from '@linedesk/db'
import { inArray } from 'drizzle-orm'
import type { Handler } from './handler-context.ts'

const MODES_KEY = 'signup_access.modes'
const INVITES_KEY = 'signup_access.invites'

type Reader = Pick<Tx, 'select'>

/** The countries this install can serve, in order, with the mode each has while no admin set one. */
export async function servableCountries(_tx?: Reader): Promise<{ country: string; defaultMode: SignupMode }[]> {
  return [
    ...SIGNUP_COUNTRIES.map(country => ({ country, defaultMode: 'open' as const })),
    ...SIGNUP_ACCESS_COUNTRIES.map(country => ({ country, defaultMode: 'invited' as const })),
  ]
}

async function settings(tx: Reader): Promise<{ modes: Record<string, SignupMode>; invites: string[] }> {
  const rows = await tx
    .select({ key: instance_settings.key, value: instance_settings.value })
    .from(instance_settings)
    .where(inArray(instance_settings.key, [MODES_KEY, INVITES_KEY]))
  const value = (key: string) => rows.find(r => r.key === key)?.value
  return { modes: parseModes(value(MODES_KEY)), invites: parseInvites(value(INVITES_KEY)) }
}

/** The stored modes (a JSON object of country → mode); anything else reads as none set. */
function parseModes(raw: string | undefined): Record<string, SignupMode> {
  const stored = parseJson(raw)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).filter((e): e is [string, SignupMode] =>
      (SIGNUP_MODES as readonly unknown[]).includes(e[1]),
    ),
  )
}

/** The stored list (a JSON array of addresses); anything else reads as empty. */
function parseInvites(raw: string | undefined): string[] {
  const list = parseJson(raw)
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : []
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function data(tx: Reader): Promise<SignupAccessData> {
  const { modes, invites } = await settings(tx)
  return {
    countries: (await servableCountries(tx)).map(c => ({ ...c, mode: modes[c.country] ?? c.defaultMode })),
    invites,
  }
}

/**
 * The countries a sign-up with this address may pick, in order: the ones open to everyone, and the ones for invited
 * addresses when it is on the list. `email` null (nobody known, the public sign-up page): only the open ones.
 */
export async function accessCountriesFor(tx: Reader, email: string | null): Promise<string[]> {
  const { countries, invites } = await data(tx)
  const invited = !!email && invites.includes(normalizeInviteEmail(email))
  return countries.filter(c => c.mode === 'open' || (c.mode === 'invited' && invited)).map(c => c.country)
}

async function store(tx: Tx, key: string, value: string, actorId: string, now: string) {
  await tx
    .insert(instance_settings)
    .values({ key, value, updated_at: now, updated_by: actorId })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actorId } })
}

export const signupAccessHandlers: Record<string, Handler> = {
  'signupAccess.get': async ({ tx }) => ({ rows: {}, data: await data(tx) }),

  /** Server admin › Sign-up: a country's sign-up mode, or who is invited. Audited (audit.ts). */
  'signupAccess.set': async ({ tx, actor, now }, input: { modes?: Record<string, SignupMode>; invites?: string[] }) => {
    if (input.modes !== undefined) {
      const servable = new Set((await servableCountries(tx)).map(c => c.country))
      const { modes } = await settings(tx)
      for (const [country, mode] of Object.entries(input.modes)) if (servable.has(country)) modes[country] = mode
      await store(tx, MODES_KEY, JSON.stringify(modes), actor.actorId, now)
    }
    if (input.invites !== undefined) {
      const invites = [...new Set(input.invites.map(normalizeInviteEmail))].sort()
      await store(tx, INVITES_KEY, JSON.stringify(invites), actor.actorId, now)
    }
    return { rows: {}, data: await data(tx) }
  },
}
