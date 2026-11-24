// Find your business (onboarding): business.search and business.import. Google and the language model are
// replaced by a stubbed fetch; the key comes from the environment of this test file's worker only.
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { business_lookup_usage, organization } from '@linedesk/db'
import { and, eq, sql } from 'drizzle-orm'
import {
  BUSINESS_SEARCHES_PER_HOUR,
  DEFAULT_DAILY_CAP,
  DEFAULT_WORKSPACE_DAILY_CAP,
  dailyCap,
  modelProblem,
  parseBusinessAnswer,
  websiteImportFor,
  workspaceDailyCap,
} from '../src/business-import.ts'
import { db } from '../src/db.ts'
import {
  act,
  addMember,
  asServerAdmin,
  createWorkspace,
  getAssistant,
  request,
  signUp,
  type Workspace,
} from './helpers.ts'

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Find Plumbing')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Today's count in business_lookup_usage: a workspace's, or the whole server's (INSTALL). */
const INSTALL = ''
const usedToday = async (workspaceId: string) =>
  (
    await db
      .select()
      .from(business_lookup_usage)
      .where(
        and(
          eq(business_lookup_usage.day, sql`(now() at time zone 'utc')::date`),
          eq(business_lookup_usage.workspace_id, workspaceId),
        ),
      )
  )[0]?.requests ?? 0

const realFetch = globalThis.fetch
type Route = (url: string, init: RequestInit) => unknown | undefined
/**
 * Answers Google and the model (a route may give a whole Response); anything else goes through. Returns the calls
 * Google and the model got.
 */
function stubFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const prefix = Object.keys(routes).find(p => url.startsWith(p))
    if (!prefix) return realFetch(input, init)
    calls.push({ url, init })
    const answer = routes[prefix]!(url, init)
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200 })
  })
  return calls
}

const LISTING = {
  id: 'ChIJbrightwater0001',
  displayName: { text: 'Brightwater Plumbing & Heating' },
  formattedAddress: '1200 SE Main St, Portland, OR 97214, USA',
  addressComponents: [
    { longText: 'Portland', types: ['locality'] },
    { longText: 'Oregon', shortText: 'OR', types: ['administrative_area_level_1'] },
  ],
  internationalPhoneNumber: '+1 503-555-0142',
  primaryType: 'plumber',
  types: ['plumber', 'point_of_interest'],
  timeZone: { id: 'America/Los_Angeles' },
  regularOpeningHours: {
    periods: [1, 2, 3, 4, 5].map(day => ({ open: { day, hour: 7, minute: 0 }, close: { day, hour: 18, minute: 0 } })),
    weekdayDescriptions: ['Monday: 7:00 AM – 6:00 PM'],
  },
}

describe('business.search', () => {
  test('without a Places key: lookup is off and nothing is requested', async () => {
    const calls = stubFetch({ 'https://places.googleapis.com': () => ({}) })
    const res = await act(ws.owner, 'business.search', { query: 'Brightwater Plumbing, Portland' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ lookup: false, results: [] })
    expect(calls).toHaveLength(0)
  })

  test('with a key: up to five listings from Google; members may not search', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'places-key-test-0001')
    const calls = stubFetch({
      'https://places.googleapis.com/v1/places:searchText': () => ({
        places: [{ id: LISTING.id, displayName: LISTING.displayName, formattedAddress: LISTING.formattedAddress }],
      }),
    })
    const res = await act(ws.owner, 'business.search', { query: 'Brightwater Plumbing, Portland' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      lookup: true,
      results: [{ placeId: LISTING.id, name: 'Brightwater Plumbing & Heating', address: LISTING.formattedAddress }],
    })
    expect(new Headers(calls[0]!.init.headers).get('x-goog-api-key')).toBe('places-key-test-0001')

    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'business.search', { query: 'Brightwater' })).status).toBe(403)
    expect((await act(member, 'business.import', { assistantId: ws.assistant.id, name: 'X' })).status).toBe(403)
    expect(calls).toHaveLength(1)
  })

  test('a key Google refuses: lookup is off with the reason, for the step to say who can fix it', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'places-key-test-0001')
    stubFetch({ 'https://places.googleapis.com': () => new Response('{}', { status: 403 }) })
    const own = await createWorkspace('Refused Plumbing')
    const res = await act(own.owner, 'business.search', { query: 'Refused Plumbing' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ lookup: false, results: [], failure: { provider: 'business', reason: 'auth' } })
    const listing = await act(own.owner, 'business.import', {
      assistantId: own.assistant.id,
      placeId: LISTING.id,
      name: 'Refused Plumbing',
    })
    expect(listing.status).toBe(200)
    expect(listing.body.data.failures).toContainEqual({ provider: 'business', reason: 'auth' })
  })

  test('searches are limited per workspace and hour', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'places-key-test-0001')
    stubFetch({ 'https://places.googleapis.com': () => ({ places: [] }) })
    const own = await createWorkspace('Busy Plumbing')
    for (let i = 0; i < BUSINESS_SEARCHES_PER_HOUR; i++)
      expect((await act(own.owner, 'business.search', { query: `Busy ${i}` })).status).toBe(200)
    const blocked = await act(own.owner, 'business.search', { query: 'Busy again' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/Too many searches/)
  })

  test('the whole server has a daily cap, counted in the database; 0 turns lookup off', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'places-key-test-0001')
    const calls = stubFetch({ 'https://places.googleapis.com': () => ({ places: [] }) })
    const own = await createWorkspace('Capped Plumbing')

    // One lookup left today: it goes to Google and is counted; the next one is refused before Google.
    vi.stubEnv('BUSINESS_LOOKUP_DAILY_CAP', String((await usedToday(INSTALL)) + 1))
    expect((await act(own.owner, 'business.search', { query: 'Capped one' })).status).toBe(200)
    const before = { install: await usedToday(INSTALL), workspace: await usedToday(own.id) }
    expect(before.workspace).toBe(1)
    const refused = await act(own.owner, 'business.search', { query: 'Capped two' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/limit on this server/)
    const importRefused = await act(own.owner, 'business.import', {
      assistantId: own.assistant.id,
      placeId: LISTING.id,
    })
    expect(importRefused.status).toBe(409)
    // Refused: counted neither for the server nor for the workspace.
    expect({ install: await usedToday(INSTALL), workspace: await usedToday(own.id) }).toEqual(before)
    expect(calls).toHaveLength(1)

    vi.stubEnv('BUSINESS_LOOKUP_DAILY_CAP', '0')
    expect((await act(own.owner, 'business.search', { query: 'Capped three' })).status).toBe(409)
    expect(calls).toHaveLength(1)
  })

  test("each workspace has its own daily cap, so one cannot use up the server's day", async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'places-key-test-0001')
    vi.stubEnv('BUSINESS_LOOKUP_WORKSPACE_DAILY_CAP', '2')
    const calls = stubFetch({ 'https://places.googleapis.com': () => ({ places: [] }) })
    const greedy = await createWorkspace('Greedy Plumbing')
    const other = await createWorkspace('Other Plumbing')
    for (const query of ['Greedy one', 'Greedy two'])
      expect((await act(greedy.owner, 'business.search', { query })).status).toBe(200)
    const refused = await act(greedy.owner, 'business.search', { query: 'Greedy three' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/used today's business lookups/)
    expect(await usedToday(greedy.id)).toBe(2)
    expect((await act(other.owner, 'business.search', { query: 'Other one' })).status).toBe(200)
    expect(calls).toHaveLength(3)
  })

  test('a website-only import counts against the daily caps too', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'model-key-test-0001')
    vi.stubEnv('BUSINESS_LOOKUP_WORKSPACE_DAILY_CAP', '1')
    const own = await createWorkspace('Website Plumbing')
    const input = { assistantId: own.assistant.id, name: 'Website Plumbing', website: 'http://127.0.0.1/admin' }
    expect((await act(own.owner, 'business.import', input)).status).toBe(200)
    expect(await usedToday(own.id)).toBe(1)
    const refused = await act(own.owner, 'business.import', input)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/used today's business lookups/)
  })

  test('website import: offered only with a model and while the caps allow it', async () => {
    const own = await createWorkspace('Offered Plumbing')
    const roomy = { install: 1_000_000, workspace: 2 }
    expect(await websiteImportFor(own.id, roomy)).toBe('no_model')
    vi.stubEnv('OPENROUTER_API_KEY', 'model-key-test-0001')
    expect(await websiteImportFor(own.id, roomy)).toBe('on')
    expect(await websiteImportFor(own.id, { ...roomy, install: 0 })).toBe('paused')
    expect(await websiteImportFor(own.id, { ...roomy, workspace: 0 })).toBe('paused')
    // Today's are used up: this workspace's, or the whole server's.
    vi.stubEnv('BUSINESS_LOOKUP_WORKSPACE_DAILY_CAP', '1')
    const input = { assistantId: own.assistant.id, name: 'Offered Plumbing', website: 'http://127.0.0.1/admin' }
    expect((await act(own.owner, 'business.import', input)).status).toBe(200)
    expect(await websiteImportFor(own.id, { ...roomy, workspace: 1 })).toBe('paused')
    const fresh = await createWorkspace('Fresh Plumbing')
    expect(await websiteImportFor(fresh.id, roomy)).toBe('on')
    expect(await websiteImportFor(fresh.id, { install: await usedToday(INSTALL), workspace: 2 })).toBe('paused')
  })

  test('without a model a website-only import reads no page and counts nothing; it says the model is missing', async () => {
    const own = await createWorkspace('Modelless Plumbing')
    const calls = stubFetch({ 'https://brightwater-plumbing.example': () => ({}) })
    const res = await act(own.owner, 'business.import', {
      assistantId: own.assistant.id,
      name: 'Modelless Plumbing',
      website: 'https://brightwater-plumbing.example',
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ name: 'Modelless Plumbing', pages: [], notes: [] })
    expect(res.body.data.failures).toEqual([{ provider: 'llm', reason: 'config' }])
    expect(await usedToday(own.id)).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test('the cap settings: a whole number, else the default', () => {
    expect(dailyCap({})).toBe(DEFAULT_DAILY_CAP)
    expect(dailyCap({ BUSINESS_LOOKUP_DAILY_CAP: '50' })).toBe(50)
    expect(dailyCap({ BUSINESS_LOOKUP_DAILY_CAP: '0' })).toBe(0)
    for (const bad of ['', ' ', '-1', '2.5', 'many'])
      expect(dailyCap({ BUSINESS_LOOKUP_DAILY_CAP: bad }), bad).toBe(DEFAULT_DAILY_CAP)
    expect(workspaceDailyCap({})).toBe(DEFAULT_WORKSPACE_DAILY_CAP)
    expect(workspaceDailyCap({ BUSINESS_LOOKUP_WORKSPACE_DAILY_CAP: '5' })).toBe(5)
  })
})

test('the note says why the model gave nothing: too slow, not JSON, or not reached', () => {
  expect(modelProblem(new DOMException('timed out', 'TimeoutError'))).toMatch(/did not answer in time/)
  expect(modelProblem(new SyntaxError('Unexpected token'))).toMatch(/no usable answer/)
  expect(modelProblem(new Error('HTTP 502'))).toMatch(/could not be reached/)
})

describe('/v1/me: what Find your business offers after onboarding ("Step by step" from the settings)', () => {
  test('owners and admins once onboarding is over; members never; while it is open, its own state says it', async () => {
    const fresh = await createWorkspace('Step Plumbing')
    const open = (await request(fresh.owner, 'GET', '/v1/me')).body
    expect(open.onboarding).toMatchObject({ businessLookup: false })
    expect(open.businessSetup).toBeNull()
    expect((await act(fresh.owner, 'onboarding.setStep', { step: 'skipped' })).status).toBe(200)
    const after = (await request(fresh.owner, 'GET', '/v1/me')).body
    expect(after.onboarding).toBeNull()
    expect(after.businessSetup).toEqual({
      businessLookup: false,
      websiteImport: expect.stringMatching(/^(on|no_model|paused)$/),
    })
    const admin = await addMember(fresh.id, 'admin')
    expect((await request(admin, 'GET', '/v1/me')).body.businessSetup).toMatchObject({ businessLookup: false })
    const member = await addMember(fresh.id, 'member')
    expect((await request(member, 'GET', '/v1/me')).body.businessSetup).toBeNull()
  })
})

describe('workspace.rename', () => {
  test('owners rename the workspace (the business name); members may not; the name is checked', async () => {
    const own = await createWorkspace('Old Name Plumbing')
    const res = await act(own.owner, 'workspace.rename', { name: '  Brightwater Plumbing  ' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: own.id, name: 'Brightwater Plumbing' })
    const [row] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, own.id))
    expect(row!.name).toBe('Brightwater Plumbing')

    const member = await addMember(own.id, 'member')
    expect((await act(member, 'workspace.rename', { name: 'Taken Over' })).status).toBe(403)
    expect((await act(own.owner, 'workspace.rename', { name: '   ' })).status).toBe(422)
    for (const bad of ['x'.repeat(81), 'Two\nlines', 'Tab\there', 'Bidi \u202Egnirts', 'Isolate \u2067x'])
      expect((await act(own.owner, 'workspace.rename', { name: bad })).status, JSON.stringify(bad)).toBe(422)
    expect((await act(own.owner, 'workspace.rename', { name: 'x'.repeat(80) })).status).toBe(200)
  })

  test('creating a workspace checks the name the same way', async () => {
    const user = await signUp()
    await asServerAdmin(user, async () => {
      for (const name of ['', 'x'.repeat(81), 'Two\nlines', 'Bidi \u202Egnirts'])
        expect((await request(user, 'POST', '/v1/workspaces', { name })).status, JSON.stringify(name)).toBe(422)
    })
  })
})

describe('business.import', () => {
  test('a listing and the model: a profile for review, nothing saved', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'places-key-test-0001')
    vi.stubEnv('OPENROUTER_API_KEY', 'model-key-test-0001')
    const before = await getAssistant(ws.assistant.id)
    const calls = stubFetch({
      'https://places.googleapis.com/v1/places/': () => LISTING,
      'https://openrouter.ai/api/v1/chat/completions': () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                about: 'We are a family plumbing company in Portland.',
                services: ['Drain cleaning', 'Water heaters'],
                area: 'Portland metro',
                use_cases: ['When a caller asks about water heaters, offer a free estimate.'],
              }),
            },
          },
        ],
      }),
    })
    const res = await act(ws.owner, 'business.import', { assistantId: ws.assistant.id, placeId: LISTING.id })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      name: 'Brightwater Plumbing & Heating',
      address: LISTING.formattedAddress,
      area: 'Portland metro',
      phone: '+1 503-555-0142',
      website: null,
      timeZone: 'America/Los_Angeles',
      kind: 'plumbing_hvac',
      template: 'plumbing_hvac',
      services: ['Drain cleaning', 'Water heaters'],
      about: 'We are a family plumbing company in Portland.',
      useCases: ['When a caller asks about water heaters, offer a free estimate.'],
      greeting: `Thanks for calling Brightwater Plumbing & Heating. This is ${before!.name}, the AI assistant. How can I help?`,
      notes: [],
      failures: [],
    })
    expect(res.body.data.hours).toHaveLength(5)
    expect(res.body.data.hours[0]).toEqual({ weekday: 1, start: '07:00', end: '18:00' })
    // The listing went to the model fenced as data.
    const prompt = JSON.parse(calls.find(c => c.url.includes('openrouter'))!.init.body as string).messages[1].content
    expect(prompt).toMatch(/^<listing>\nName: Brightwater Plumbing & Heating/)
    // Read-only: the assistant is as it was.
    expect((await getAssistant(ws.assistant.id))!.version).toBe(before!.version)
  })

  test('without a key or a model: the name alone gives a template and a greeting; a listing says the key is missing', async () => {
    const calls = stubFetch({ 'https://places.googleapis.com': () => LISTING })
    const res = await act(ws.owner, 'business.import', { assistantId: ws.assistant.id, name: 'Lakeside Dental' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      name: 'Lakeside Dental',
      kind: 'dental',
      template: 'dental_medical',
      hours: null,
      about: '',
      notes: [],
      failures: [],
    })
    const listing = await act(ws.owner, 'business.import', {
      assistantId: ws.assistant.id,
      placeId: LISTING.id,
      name: 'Lakeside Dental',
    })
    expect(listing.status).toBe(200)
    expect(listing.body.data).toMatchObject({ name: 'Lakeside Dental', address: null })
    expect(listing.body.data.failures).toEqual([{ provider: 'business', reason: 'config' }])
    expect(calls).toHaveLength(0)
    const shop = await act(ws.owner, 'business.import', { assistantId: ws.assistant.id, name: 'The Corner Bookshop' })
    expect(shop.body.data).toMatchObject({ kind: 'retail_store', template: 'retail_store' })
    const unknown = await act(ws.owner, 'business.import', { assistantId: ws.assistant.id, name: 'Joe Smith' })
    expect(unknown.body.data).toMatchObject({ kind: null, template: null })
  })

  test("the model's kind of business: only one from the list counts", () => {
    const answer = (kind: unknown) => parseBusinessAnswer(JSON.stringify({ about: 'We sell tea.', kind }))
    expect(answer('online_store').kind).toBe('online_store')
    expect(answer('tea_shop').kind).toBeNull()
    expect(parseBusinessAnswer(JSON.stringify({ about: 'We sell tea.' })).kind).toBeNull()
  })

  test('a private website is refused by the SSRF guard and named in the notes, the rest still comes back', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'model-key-test-0001')
    const res = await act(ws.owner, 'business.import', {
      assistantId: ws.assistant.id,
      name: 'Brightwater',
      website: 'http://127.0.0.1/admin',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.notes[0]).toMatch(/could not be read: .*private/)
    expect(res.body.data.pages).toEqual([])
  })

  test('input: a place ID is checked before it goes into a URL; something to go on is required', async () => {
    for (const placeId of ['../../admin', 'a b c d e f g h', 'x'])
      expect((await act(ws.owner, 'business.import', { assistantId: ws.assistant.id, placeId })).status, placeId).toBe(
        422,
      )
    expect((await act(ws.owner, 'business.import', { assistantId: ws.assistant.id })).status).toBe(422)
    const other = await createWorkspace('Other Plumbing')
    expect((await act(ws.owner, 'business.import', { assistantId: other.assistant.id, name: 'X' })).status).toBe(409)
  })
})
