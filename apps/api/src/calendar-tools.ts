// Which calendar tools beyond Google and Microsoft members may connect, and how (instance_settings, one JSON row):
// off (the default), with their own key, or with one click through the install's OAuth app. What is off is not
// offered, cannot be connected, and its calendars are not booked into.
import type { CalendarTool, CalendarToolMode, CalendarToolModes, CalendarToolsData } from '@linedesk/actions'
import { calendarOAuthFromEnv, configuredCalendarProviders, type CalendarProviderName } from '@linedesk/calendar'
import { instance_settings, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { type Handler, Reject } from './handler-context.ts'

const KEY = 'calendar_tools'
export const CALENDAR_TOOLS: readonly CalendarTool[] = ['caldav', 'calendly', 'calcom']
const OFF: CalendarToolModes = { caldav: 'off', calendly: 'off', calcom: 'off' }
const MODES: readonly CalendarToolMode[] = ['off', 'keys', 'oauth']

type Env = Record<string, string | undefined>

export async function calendarToolModes(reader: Pick<Tx, 'select'> = db): Promise<CalendarToolModes> {
  const [row] = await reader
    .select({ value: instance_settings.value })
    .from(instance_settings)
    .where(eq(instance_settings.key, KEY))
  if (!row) return OFF
  let stored: Partial<Record<string, unknown>> = {}
  try {
    stored = JSON.parse(row.value)
  } catch {}
  return Object.fromEntries(
    CALENDAR_TOOLS.map(t => [t, MODES.includes(stored[t] as CalendarToolMode) ? stored[t] : 'off']),
  ) as CalendarToolModes
}

const toolApps = (env: Env): CalendarTool[] =>
  (['calendly', 'calcom'] as const).filter(t => calendarOAuthFromEnv(t, env))

/** How a provider connects on this install now: by consent page, with a key, or not at all. */
export type ConnectWay = 'oauth' | 'key'

/**
 * The providers members may connect, each with how: Google and Microsoft when their app is set up; a tool in `keys`
 * with a key; a tool in `oauth` by consent page when its app is set up (else not at all).
 */
export function connectWays(
  modes: CalendarToolModes,
  env: Env = process.env,
): Partial<Record<CalendarProviderName, ConnectWay>> {
  const ways: Partial<Record<CalendarProviderName, ConnectWay>> = {}
  for (const p of configuredCalendarProviders(env)) if (p === 'google' || p === 'microsoft') ways[p] = 'oauth'
  for (const tool of CALENDAR_TOOLS) {
    const mode = modes[tool]
    if (mode === 'keys') ways[tool] = 'key'
    else if (mode === 'oauth' && tool !== 'caldav' && calendarOAuthFromEnv(tool, env)) ways[tool] = 'oauth'
  }
  return ways
}

/** Refuses a connect or booking through a tool that is off, or on in another way. */
export async function assertToolWay(tx: Pick<Tx, 'select'>, provider: CalendarProviderName, way: ConnectWay | 'use') {
  if (provider === 'google' || provider === 'microsoft') return
  const allowed = connectWays(await calendarToolModes(tx))[provider]
  if (!allowed || (way !== 'use' && allowed !== way))
    throw new Reject(
      `${provider === 'caldav' ? 'CalDAV calendars are' : `${provider === 'calcom' ? 'Cal.com' : 'Calendly'} is`} not switched on on this server${way === 'use' ? '' : ' for this way of connecting'}.`,
    )
}

export const calendarToolHandlers: Record<string, Handler> = {
  'calendarTools.get': async ({ tx }) => {
    const data: CalendarToolsData = { modes: await calendarToolModes(tx), apps: toolApps(process.env) }
    return { rows: {}, data }
  },

  'calendarTools.set': async ({ tx, actor, now }, input: { tool: CalendarTool; mode: CalendarToolMode }) => {
    if (input.tool === 'caldav' && input.mode === 'oauth')
      throw new Reject('CalDAV has no one-click connect: members use an app-specific password.')
    if (input.mode === 'oauth' && !calendarOAuthFromEnv(input.tool as 'calendly' | 'calcom', process.env)) {
      throw new Reject(
        `Set up the ${input.tool === 'calcom' ? 'Cal.com' : 'Calendly'} app first (client ID and secret, below).`,
      )
    }
    const modes = { ...(await calendarToolModes(tx)), [input.tool]: input.mode }
    const value = JSON.stringify(modes)
    await tx
      .insert(instance_settings)
      .values({ key: KEY, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    const data: CalendarToolsData = { modes, apps: toolApps(process.env) }
    return { rows: {}, data }
  },
}
