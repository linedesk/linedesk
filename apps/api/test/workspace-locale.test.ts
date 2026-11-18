// The workspace's country (workspace_settings.country): set in Workspace settings › General, else worked out when read;
// its language follows the country (no setting of its own since 2026-11-16). A US workspace reads US and English as
// before; call.start brings both to the agent.
import { phone_numbers, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { COUNTRY_HEADER } from '../src/country-hint.ts'
import { db } from '../src/db.ts'
import {
  act,
  addMember,
  agent,
  anonymous,
  asServerAdmin,
  createWorkspace,
  randomNumber,
  request,
  signUp,
  type User,
} from './helpers.ts'

describe('workspace country and language', () => {
  test('a US workspace: automatic, US and English, USD; call.start brings them', async () => {
    const ws = await createWorkspace('Locale US Plumbing')
    const data = (await act(ws.owner, 'workspace.getSettings', {})).body.data
    expect(data).toMatchObject({
      country: null,
      resolvedCountry: 'US',
      countrySource: 'assistant_number',
      resolvedLanguage: 'en',
      jobValueCurrency: 'USD',
    })
    const call = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
    expect(call).toMatchObject({ workspaceCountry: 'US', workspaceLanguage: 'en' })
  })

  test('worked out from a Mexican number; set by the owner; back to automatic with null', async () => {
    const ws = await createWorkspace('Locale MX Plomería')
    await db
      .update(phone_numbers)
      .set({ e164: '+5255' + String(Date.now()).slice(-8) })
      .where(eq(phone_numbers.e164, ws.number))
    const auto = (await act(ws.owner, 'workspace.getSettings', {})).body.data
    expect(auto).toMatchObject({
      resolvedCountry: 'MX',
      resolvedLanguage: 'es',
      jobValueCurrency: 'MXN',
      country: null,
    })

    const set = await act(ws.owner, 'workspace.updateSettings', { country: 'kr' })
    expect(set.status).toBe(200)
    expect(set.body.data).toMatchObject({
      country: 'KR',
      resolvedCountry: 'KR',
      countrySource: 'explicit',
      resolvedLanguage: 'ko',
    })
    expect(set.body.data).not.toHaveProperty('language')
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({ jobValueCurrency: 'KRW' })

    await act(ws.owner, 'workspace.updateSettings', { country: null })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      country: null,
      resolvedCountry: 'MX',
      resolvedLanguage: 'es',
    })
  })

  test('a saved appointment value keeps its currency', async () => {
    const ws = await createWorkspace('Locale Value Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { jobValueCents: 35000, jobValueCurrency: 'USD' })
    await act(ws.owner, 'workspace.updateSettings', { country: 'GB' })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      jobValueCents: 35000,
      jobValueCurrency: 'USD',
    })
  })

  test('only owners and admins change it; unknown countries are refused; the language is no setting', async () => {
    const ws = await createWorkspace('Locale Rules Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.updateSettings', { country: 'GB' })).status).toBe(403)
    expect((await act(ws.owner, 'workspace.updateSettings', { country: 'XX' })).status).toBe(422)
    // The removed workspace "Call language" (2026-11-16): the field is no longer read, the language follows the country.
    expect((await act(ws.owner, 'workspace.updateSettings', { country: 'DE', language: 'fr' })).status).toBe(200)
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({ resolvedLanguage: 'de' })
    await act(ws.owner, 'workspace.updateSettings', { country: null })
    expect((await act(member, 'workspace.getSettings', {})).body.data.country).toBeNull()
  })

  test('the holiday lookup opens with the workspace country', async () => {
    const ws = await createWorkspace('Locale Holidays Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { country: 'GB' })
    expect((await act(ws.owner, 'holidays.lookup', {})).body.data.country).toBe('GB')
  })
})

/** A server admin's own new workspace through POST /v1/workspaces (New workspace); its settings row. */
async function created(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const owner = await signUp()
  const name = `Hint ${crypto.randomUUID().slice(0, 8)}`
  const res = await asServerAdmin(owner, () => request(owner, 'POST', '/v1/workspaces', { name, ...body }, headers))
  expect(res.status).toBe(200)
  const id: string = res.body.workspace.id
  const [row] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, id))
  return { owner, id, row: row! }
}
const settingsOf = async (who: User) => (await act(who, 'workspace.getSettings', {})).body.data

describe('the country at sign-up: set in New workspace, with a hint of where it was guessed from', () => {
  test('the country picked is saved as set; the hint keeps the sign-up location the proxy named, no address', async () => {
    const { owner, row } = await created(
      { country: 'DE', timeZone: 'Europe/Madrid', locale: 'es-ES' },
      { [COUNTRY_HEADER]: 'de' },
    )
    expect(row).toMatchObject({ country: 'DE', country_hint: 'DE', country_hint_source: 'sign_up_location' })
    expect(await settingsOf(owner)).toMatchObject({ country: 'DE', resolvedCountry: 'DE', countrySource: 'explicit' })
  })

  test("without the proxy: the time zone, then the browser language; Cloudflare's XX counts as none", async () => {
    const zone = await created(
      { country: 'ES', timeZone: 'Europe/Madrid', locale: 'de-DE' },
      { [COUNTRY_HEADER]: 'XX' },
    )
    expect(zone.row).toMatchObject({ country_hint: 'ES', country_hint_source: 'time_zone' })
    const language = await created({ country: 'AT', timeZone: 'UTC', locale: 'de-AT' })
    expect(language.row).toMatchObject({ country: 'AT', country_hint: 'AT', country_hint_source: 'browser_language' })
  })

  test('made without a country (API, setup MCP, command line): Automatic, from the hint, before the US default', async () => {
    const { owner, row } = await created({ timeZone: 'Europe/Madrid' }, { [COUNTRY_HEADER]: 'DE' })
    expect(row).toMatchObject({ country: null, country_hint: 'DE', country_hint_source: 'sign_up_location' })
    expect(await settingsOf(owner)).toMatchObject({
      country: null,
      resolvedCountry: 'DE',
      countrySource: 'sign_up_location',
      resolvedLanguage: 'de',
      jobValueCurrency: 'EUR',
    })
  })

  test('an unknown country is refused and nothing is made', async () => {
    const owner = await signUp()
    const res = await asServerAdmin(owner, () =>
      request(owner, 'POST', '/v1/workspaces', { name: `Hint ${crypto.randomUUID().slice(0, 8)}`, country: 'XX' }),
    )
    expect(res.status).toBe(422)
  })

  test('workspace.create takes the country and the hint the app prefilled it with', async () => {
    const admin = await signUp()
    const name = `Hint ${crypto.randomUUID().slice(0, 8)}`
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', {
        name,
        country: 'fr',
        countryHint: { country: 'BE', source: 'browser_language' },
      }),
    )
    expect(made.status).toBe(200)
    const [row] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, made.body.data.workspace.id))
    expect(row).toMatchObject({ country: 'FR', country_hint: 'BE', country_hint_source: 'browser_language' })
    const refused = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', { name: `${name} 2`, countryHint: { country: 'DE', source: 'guess' } }),
    )
    expect(refused.status).toBe(422)
  })

  test('the prefilled country left as it is stays Automatic: a number connected later still decides it', async () => {
    // New workspace sends no country when the field was not changed; the hint is all that is kept.
    const { row } = await created({ timeZone: 'Europe/Berlin', locale: 'de-DE' }, { [COUNTRY_HEADER]: 'DE' })
    expect(row).toMatchObject({ country: null, country_hint: 'DE', country_hint_source: 'sign_up_location' })
    // A workspace with a US number and the same hint: the number wins, so the assistant says 911, not 112.
    const ws = await createWorkspace('Hint Number Wins Plumbing')
    await db
      .update(workspace_settings)
      .set({ country: null, country_hint: 'DE', country_hint_source: 'sign_up_location' })
      .where(eq(workspace_settings.workspace_id, ws.id))
    expect(await settingsOf(ws.owner)).toMatchObject({ resolvedCountry: 'US', countrySource: 'assistant_number' })
  })

  test('the hint comes from the time zone the caller sent, never from the US Eastern fallback', async () => {
    const admin = await signUp()
    const rowOf = async (input: Record<string, unknown>) => {
      const made = await asServerAdmin(admin, () =>
        act(admin, 'workspace.create', { name: `Hint ${crypto.randomUUID().slice(0, 8)}`, ...input }),
      )
      expect(made.status).toBe(200)
      const [row] = await db
        .select()
        .from(workspace_settings)
        .where(eq(workspace_settings.workspace_id, made.body.data.workspace.id))
      return row!
    }
    // The setup MCP or the command line without a time zone: nothing known, so no hint (not "US, from the time zone").
    expect(await rowOf({})).toMatchObject({
      timezone: 'America/New_York',
      country_hint: null,
      country_hint_source: null,
    })
    expect(await rowOf({ timeZone: 'Europe/Madrid' })).toMatchObject({
      country_hint: 'ES',
      country_hint_source: 'time_zone',
    })
  })

  test("for another owner, never the admin's own sign-up location", async () => {
    const admin = await signUp()
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', {
        name: `Hint ${crypto.randomUUID().slice(0, 8)}`,
        timeZone: 'America/Chicago',
        countryHint: { country: 'DE', source: 'sign_up_location' },
        owner: { email: `hint-${crypto.randomUUID().slice(0, 8)}@example.com`, name: 'Dana Ruiz' },
      }),
    )
    expect(made.status).toBe(200)
    const [row] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, made.body.data.workspace.id))
    expect(row).toMatchObject({ country: null, country_hint: 'US', country_hint_source: 'time_zone' })
    // A hint from the browser (time zone, language) is kept as sent.
    const browser = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', {
        name: `Hint ${crypto.randomUUID().slice(0, 8)}`,
        countryHint: { country: 'CA', source: 'browser_language' },
        owner: { email: `hint-${crypto.randomUUID().slice(0, 8)}@example.com`, name: 'Kim Lee' },
      }),
    )
    const [kept] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, browser.body.data.workspace.id))
    expect(kept).toMatchObject({ country_hint: 'CA', country_hint_source: 'browser_language' })
  })

  test('the database refuses a hint that is not a code with a known source', async () => {
    const ws = await createWorkspace('Hint Check Plumbing')
    const set = (values: Record<string, unknown>) =>
      db.update(workspace_settings).set(values).where(eq(workspace_settings.workspace_id, ws.id))
    await expect(set({ country_hint: 'de' })).rejects.toThrow()
    await expect(set({ country_hint_source: 'guess' })).rejects.toThrow()
    await set({ country_hint: 'DE', country_hint_source: 'time_zone' })
  })
})

describe('the time zone of a new workspace follows its country (LIN-433)', () => {
  test("the browser's zone when it is in the country, else the country's main zone", async () => {
    // A US business set up from a browser in Berlin: US Eastern, not Berlin.
    const picked = await created({ country: 'US', timeZone: 'Europe/Berlin', locale: 'de-DE' })
    expect(picked.row).toMatchObject({ country: 'US', timezone: 'America/New_York' })
    const kept = await created({ country: 'US', timeZone: 'America/Chicago' })
    expect(kept.row.timezone).toBe('America/Chicago')
    // Left as prefilled (the sign-up location): the hint's country decides; the hint itself is unchanged.
    const hinted = await created({ timeZone: 'Europe/Berlin' }, { [COUNTRY_HEADER]: 'CA' })
    expect(hinted.row).toMatchObject({
      country: null,
      country_hint: 'CA',
      country_hint_source: 'sign_up_location',
      timezone: 'America/Toronto',
    })
  })

  test('for another owner: the country the admin picked or prefilled', async () => {
    const admin = await signUp()
    const made = await asServerAdmin(admin, () =>
      act(admin, 'workspace.create', {
        name: `Zone ${crypto.randomUUID().slice(0, 8)}`,
        timeZone: 'Europe/Berlin',
        countryHint: { country: 'AU', source: 'browser_language' },
        owner: { email: `zone-${crypto.randomUUID().slice(0, 8)}@example.com`, name: 'Dana Ruiz' },
      }),
    )
    expect(made.status).toBe(200)
    const [row] = await db
      .select()
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, made.body.data.workspace.id))
    expect(row).toMatchObject({ country_hint: 'AU', timezone: 'Australia/Sydney' })
  })
})

describe('GET /v1/workspaces/country-hint', () => {
  test("the hint for New workspace: the proxy's country, else the time zone, else the language; never stored", async () => {
    const who = await signUp()
    const path = '/v1/workspaces/country-hint?timeZone=Europe%2FMadrid&locale=fr-FR'
    expect((await request(who, 'GET', path, undefined, { [COUNTRY_HEADER]: 'DE' })).body).toEqual({
      ok: true,
      hint: { country: 'DE', source: 'sign_up_location' },
    })
    expect((await request(who, 'GET', path)).body.hint).toEqual({ country: 'ES', source: 'time_zone' })
    expect((await request(who, 'GET', '/v1/workspaces/country-hint?locale=fr-FR')).body.hint).toEqual({
      country: 'FR',
      source: 'browser_language',
    })
    expect((await request(who, 'GET', '/v1/workspaces/country-hint')).body.hint).toBeNull()
  })

  test('only for signed-in accounts', async () => {
    expect((await request(anonymous, 'GET', '/v1/workspaces/country-hint')).status).toBe(401)
  })
})

describe('the time zone and currency follow the country until set by hand (LIN-580)', () => {
  const settingsOf = async (owner: User) => (await act(owner, 'workspace.getSettings', {})).body.data

  test('following: they move with the country; a value keeps its amount in the new currency', async () => {
    const ws = await createWorkspace('Follows Country Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { country: 'US', timeZone: null })
    await act(ws.owner, 'workspace.updateSettings', { jobValueCents: 35000 })
    expect(await settingsOf(ws.owner)).toMatchObject({
      timeZone: 'America/New_York',
      timeZoneFollowsCountry: true,
      countryTimeZone: 'America/New_York',
      jobValueCents: 35000,
      jobValueCurrency: 'USD',
      jobValueCurrencyFollowsCountry: true,
    })
    await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })
    expect(await settingsOf(ws.owner)).toMatchObject({
      timeZone: 'Europe/Berlin',
      timeZoneFollowsCountry: true,
      jobValueCents: 35000,
      jobValueCurrency: 'EUR',
      countryCurrency: 'EUR',
    })
    // To Japan: ¥350, whole yen (no minor units), not ¥35,000.
    await act(ws.owner, 'workspace.updateSettings', { country: 'JP' })
    expect(await settingsOf(ws.owner)).toMatchObject({
      timeZone: 'Asia/Tokyo',
      jobValueCents: 350,
      jobValueCurrency: 'JPY',
    })
  })

  test('set by hand: they stay when the country changes; null follows the country again', async () => {
    const ws = await createWorkspace('Set By Hand Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { country: 'US' })
    await act(ws.owner, 'workspace.updateSettings', { timeZone: 'America/Chicago' })
    await act(ws.owner, 'workspace.updateSettings', { jobValueCurrency: 'CAD' })
    await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })
    expect(await settingsOf(ws.owner)).toMatchObject({
      timeZone: 'America/Chicago',
      timeZoneFollowsCountry: false,
      countryTimeZone: 'Europe/Berlin',
      jobValueCurrency: 'CAD',
      jobValueCurrencyFollowsCountry: false,
      countryCurrency: 'EUR',
    })
    const back = await act(ws.owner, 'workspace.updateSettings', { timeZone: null, jobValueCurrency: null })
    expect(back.status).toBe(200)
    expect(back.body.data).toMatchObject({
      timeZone: 'Europe/Berlin',
      timeZoneFollowsCountry: true,
      jobValueCurrency: 'EUR',
      jobValueCurrencyFollowsCountry: true,
    })
  })

  test('a following time zone already in the new country stays where it is', async () => {
    const ws = await createWorkspace('Stays In Country Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { country: 'DE' })
    await db
      .update(workspace_settings)
      .set({ timezone: 'America/Denver', timezone_follows_country: true })
      .where(eq(workspace_settings.workspace_id, ws.id))
    await act(ws.owner, 'workspace.updateSettings', { country: 'US' })
    expect(await settingsOf(ws.owner)).toMatchObject({ timeZone: 'America/Denver', timeZoneFollowsCountry: true })
  })

  test('a value typed while the currency follows is saved in the currency shown', async () => {
    const ws = await createWorkspace('Typed Value Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { country: 'GB' })
    await act(ws.owner, 'workspace.updateSettings', { jobValueCents: 12000 })
    expect(await settingsOf(ws.owner)).toMatchObject({
      jobValueCents: 12000,
      jobValueCurrency: 'GBP',
      jobValueCurrencyFollowsCountry: true,
    })
  })
})
