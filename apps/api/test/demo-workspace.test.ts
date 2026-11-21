// The demo-workspace script (demo-workspace.ts): one workspace with an assistant per industry of the data file, set up
// for public demo calls, safe to run again. Own database (vitest.config.ts): it makes a server admin.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assistants, organization, user, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { parseDemoAssistants } from '../src/demo-call.ts'
import example from '../src/demo-businesses.example.ts'
import {
  demoInstructions,
  demoWorkspaceData,
  pairAssistants,
  readDemoData,
  setUpDemoWorkspace,
} from '../src/demo-workspace.ts'
import { signUp } from './helpers.ts'

let admin: string
let owner: string
beforeAll(async () => {
  const a = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, a.userId))
  admin = (await db.select().from(user).where(eq(user.id, a.userId)))[0]!.email
  const o = await signUp()
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, o.userId))
  owner = (await db.select().from(user).where(eq(user.id, o.userId)))[0]!.email
})

const data = demoWorkspaceData.parse(example)

test('the example data: eight made-up businesses with 555-01xx numbers, each industry and number once', () => {
  expect(data.businesses.map(b => b.industry)).toEqual([
    'home-services',
    'auto',
    'law',
    'salons',
    'vet',
    'property',
    'cleaning',
    'insurance',
  ])
  for (const b of data.businesses) expect(b.phone).toMatch(/^\(\d{3}\) 555-01\d{2}$/)
  const twice = { ...example, businesses: [example.businesses[0]!, example.businesses[0]!] }
  expect(demoWorkspaceData.safeParse(twice).success).toBe(false)
})

test('the instructions: the business, its facts, the common calls (template first) and the demo rules with its name', () => {
  const law = data.businesses.find(b => b.industry === 'law')!
  const text = demoInstructions(law, data.demoRules)
  expect(text.startsWith('Hale & Ortiz Law. A small law firm')).toBe(true)
  expect(text).toContain('Phone: (512) 555-0144.')
  expect(text).toContain('Common calls:\n- When a caller has a court deadline')
  expect(text).toContain('Demo rules:\n- This call is a public demo from a website')
  expect(text).toContain('the receptionist of Hale & Ortiz Law')
  expect(text).not.toContain('{business}')
})

test('pairing: by phone number first, then an assistant without one, else a new one', () => {
  const businesses = [
    { industry: 'a', phone: '(503) 555-0142' },
    { industry: 'b', phone: '(303) 555-0143' },
    { industry: 'c', phone: '(512) 555-0144' },
  ]
  const pairs = pairAssistants(businesses, [
    { id: 'as_free', phone: undefined },
    { id: 'as_b', phone: '+1 303-555-0143' },
    { id: 'as_other', phone: '(999) 555-0100' },
  ])
  expect([...pairs]).toEqual([
    ['a', 'as_free'],
    ['b', 'as_b'],
    ['c', null],
  ])
})

test('sets up the workspace and its assistants for demo calls, and a second run changes nothing but the texts', async () => {
  const out = await setUpDemoWorkspace({ owner, as: admin, name: 'Website Demo Test', data })
  const envLine = out.at(-1)!
  expect(envLine).toMatch(/^DEMO_ASSISTANTS=home-services=\S+,auto=\S+/)
  const mapping = parseDemoAssistants(envLine.slice('DEMO_ASSISTANTS='.length))
  expect(mapping.size).toBe(8)
  const [ws] = await db.select().from(organization).where(eq(organization.name, 'Website Demo Test'))
  expect(ws!.spendingCapCents).toBe(50_000)
  expect(out.at(-2)).toBe(`DEMO_WORKSPACE_ID=${ws!.id}`)
  const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws!.id))
  expect(settings).toMatchObject({
    recording_retention_days: 0,
    business_hours_on: false,
    notify_email_default: false,
    notify_browser_default: false,
    country: 'US',
    timezone: 'America/Los_Angeles',
  })
  const rows = await db.select().from(assistants).where(eq(assistants.workspace_id, ws!.id))
  expect(rows).toHaveLength(8)
  const auto = rows.find(r => r.id === mapping.get('auto'))!
  expect(auto).toMatchObject({
    name: 'Maya',
    greeting: 'Thanks for calling Ridgeline Auto Care. This is Maya, the AI assistant. How can I help?',
    ai_disclosure: 'at_start',
    record_calls: false,
    recording_notice_on: false,
    max_call_minutes: 2,
    transfers: [],
    languages: { main: 'en', mode: 'english', allowed: [] },
  })
  expect(auto.business_profile.phone).toBe('(303) 555-0143')
  expect(auto.business_profile.instructions).toContain('Demo rules:')

  const again = await setUpDemoWorkspace({ owner, as: admin, name: 'Website Demo Test', data })
  expect(again.at(-1)).toBe(envLine)
  expect(again.some(l => l.startsWith('Found workspace "Website Demo Test"'))).toBe(true)
  expect(await db.select().from(assistants).where(eq(assistants.workspace_id, ws!.id))).toHaveLength(8)
  expect(await db.select().from(organization).where(eq(organization.name, 'Website Demo Test'))).toHaveLength(1)
})

test('an install points the script at its own data file; a wrong one says what is wrong', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-data-'))
  const own = join(dir, 'own.json')
  const one = {
    ...example,
    businesses: [{ ...example.businesses[0]!, industry: 'plumbing', business: 'Own Plumbing Co' }],
  }
  await writeFile(own, JSON.stringify(one))
  expect((await readDemoData(own)).businesses.map(b => b.business)).toEqual(['Own Plumbing Co'])
  const bad = join(dir, 'bad.json')
  await writeFile(bad, JSON.stringify({ ...example, businesses: [{ ...example.businesses[0]!, phone: 'call me' }] }))
  await expect(readDemoData(bad)).rejects.toThrow(/businesses\.0\.phone: a phone number/)
})
