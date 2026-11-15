// Sets up the workspace that answers public demo calls (demo-call.ts): one workspace, one assistant per industry a
// website offers, from a data file (demo-businesses.example.ts is the example; --data names an install's own). Every
// assistant takes messages only: no recording (record_calls off, recordings not kept), at most 2 minutes, English only,
// says at the start that it is an AI, and puts nobody through. The workspace gets a monthly spending cap as a backstop,
// no recording notice, no notification emails by default.
// The workspace is made like workspace:create (provision in workspace-create.ts: the same owner and --as rules), and
// every change goes through the registry as that server admin. Safe to run again: an assistant is found by its
// business's phone number in the data file and updated; a missing one is added. Nothing is deleted: an assistant,
// phone number, calendar or webhook the data file does not name is only reported.
// It prints the DEMO_WORKSPACE_ID and DEMO_ASSISTANTS lines for the API's env (docs/runbook.md, "Put a live demo on your website").
//   pnpm --filter @linedesk/api demo:workspace --owner you@example.com [--owner-name …] [--as admin@example.com] [--name "Website Demo"] [--data path/to/businesses.json]
//   in the api container: node apps/api/src/demo-workspace.ts --owner … [--as …] [--data …]
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  type AssistantCreateData,
  businessPhoneProblem,
  businessTemplateIds,
  businessTemplates,
  ENGLISH_ONLY,
  greetingFor,
  INSTRUCTIONS_MAX,
  RECORDINGS_NOT_KEPT,
  SPENDING_CAP_MAX_USD,
} from '@linedesk/actions'
import { api_keys, assistant_calendars, assistants, phone_numbers, webhook_endpoints } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { runAction } from './run-action.ts'
import { adminOnServer, numberSetupActor, provision } from './workspace-create.ts'

/** The longest a demo assistant stays on a call, in minutes; the agent ends a demo call earlier (DEMO_CALL_MAX_SECONDS). */
const DEMO_MAX_CALL_MINUTES = 2

const line = z.string().trim().min(1).max(600)
const business = z.object({
  /** The website's value for this industry (`home-services`): the key in DEMO_ASSISTANTS. */
  industry: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower case letters, digits and dashes'),
  business: z.string().trim().min(1).max(80),
  /** The assistant's name, said in the greeting. */
  assistant: z.string().trim().min(1).max(60),
  /** An industry template whose common calls come first (packages/actions/src/business.ts). */
  template: z.enum(businessTemplateIds).optional(),
  about: line,
  services: z.array(line).max(20).default([]),
  area: line.optional(),
  address: line.optional(),
  hours: line.optional(),
  /** The made-up business's own number; also how a later run finds this assistant again. */
  phone: z.string().refine(p => !!p.trim() && !businessPhoneProblem(p), 'a phone number'),
  prices: line.optional(),
  /** Common calls after the template's. */
  useCases: z.array(line).max(20).default([]),
  /** How its calls are answered; missing: the install's default. */
  voicePipeline: z.enum(['realtime', 'three_stage']).optional(),
})
export const demoWorkspaceData = z.object({
  workspace: z.object({
    name: z.string().trim().min(1).max(80),
    timeZone: z.string().min(1),
    country: z.string().regex(/^[A-Z]{2}$/),
    spendingCapUsd: z.number().min(0).max(SPENDING_CAP_MAX_USD),
  }),
  /** Lines added to every assistant's instructions; `{business}` is its business's name. */
  demoRules: z.array(line).max(20),
  businesses: z
    .array(business)
    .min(1)
    .max(20)
    .refine(list => new Set(list.map(b => b.industry)).size === list.length, 'each industry once')
    .refine(list => new Set(list.map(b => digits(b.phone))).size === list.length, 'each phone number once'),
})
export type DemoWorkspaceData = z.input<typeof demoWorkspaceData>
type DemoBusiness = z.infer<typeof business>

/** A phone number's digits, without the leading 1 of a North American number written with it. */
function digits(phone: string) {
  const d = phone.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}

/** What the assistant knows, in the shape onboarding writes (About, services, area, address, common calls), then the demo rules. */
export function demoInstructions(b: DemoBusiness, demoRules: readonly string[]): string {
  const calls = [...(b.template ? businessTemplates[b.template].useCases : []), ...b.useCases]
  const text = [
    `${b.business}. ${b.about}`,
    b.services.length ? `Services: ${b.services.join('; ')}.` : null,
    b.area ? `Service area: ${b.area}.` : null,
    b.address ? `Address: ${b.address}.` : null,
    b.hours ? `Hours: ${b.hours}` : null,
    `Phone: ${b.phone}.`,
    b.prices ? `Prices: ${b.prices}` : null,
    calls.length ? `Common calls:\n${calls.map(u => `- ${u}`).join('\n')}` : null,
    demoRules.length
      ? `Demo rules:\n${demoRules.map(r => `- ${r.replaceAll('{business}', b.business)}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n')
  if (text.length > INSTRUCTIONS_MAX)
    throw new Error(`The instructions for ${b.business} are longer than ${INSTRUCTIONS_MAX} characters.`)
  return text
}

/** The assistant.update input that makes an assistant this demo business's. */
export function demoAssistantUpdate(assistantId: string, b: DemoBusiness, demoRules: readonly string[]) {
  return {
    assistantId,
    name: b.assistant,
    greeting: greetingFor(b.business, b.assistant),
    ai_disclosure: 'at_start' as const,
    record_calls: false,
    max_call_minutes: DEMO_MAX_CALL_MINUTES,
    transfers: [],
    languages: ENGLISH_ONLY,
    ...(b.voicePipeline ? { voice_pipeline: b.voicePipeline } : {}),
    business_profile: {
      instructions: demoInstructions(b, demoRules),
      description: b.about,
      services: b.services,
      ...(b.area ? { service_area: b.area } : {}),
      ...(b.address ? { address: b.address } : {}),
      ...(b.hours ? { hours: b.hours } : {}),
      phone: b.phone,
    },
  }
}

/** Reads a data file: JSON, or a module whose default export is the data. */
export async function readDemoData(path: string) {
  const full = resolve(path)
  const raw: unknown = full.endsWith('.json')
    ? JSON.parse(await readFile(full, 'utf8'))
    : ((await import(pathToFileURL(full).href)) as { default: unknown }).default
  const parsed = demoWorkspaceData.safeParse(raw)
  if (!parsed.success)
    throw new Error(
      `${path}: ${parsed.error.issues.map(i => `${i.path.join('.') || 'data'}: ${i.message}`).join('; ')}`,
    )
  return parsed.data
}

async function run(name: string, input: unknown, actor: Actor) {
  const { body } = await runAction(name, input, actor)
  if (!body.ok) throw new Error(`${name} failed: ${body.error}`)
  return body.data
}

/**
 * Pairs each business with an assistant of the workspace: the one with its phone number in its profile, else one
 * that has no phone number yet (the workspace's first assistant), else none (added then).
 */
export function pairAssistants(
  businesses: readonly Pick<DemoBusiness, 'industry' | 'phone'>[],
  existing: readonly { id: string; phone: string | undefined }[],
): Map<string, string | null> {
  const taken = new Set<string>()
  const pairs = new Map<string, string | null>()
  for (const b of businesses) {
    const own = existing.find(a => !taken.has(a.id) && a.phone && digits(a.phone) === digits(b.phone))
    if (own) taken.add(own.id)
    pairs.set(b.industry, own?.id ?? null)
  }
  for (const b of businesses) {
    if (pairs.get(b.industry)) continue
    const free = existing.find(a => !taken.has(a.id) && !a.phone?.trim())
    if (free) taken.add(free.id)
    pairs.set(b.industry, free?.id ?? null)
  }
  return pairs
}

export type DemoWorkspaceInput = {
  owner: string
  ownerName?: string
  as?: string
  name?: string
  data: Awaited<ReturnType<typeof readDemoData>>
}

/** What the command does, without the argument parsing; returns the lines it prints, the DEMO_WORKSPACE_ID and DEMO_ASSISTANTS lines last. */
export async function setUpDemoWorkspace(input: DemoWorkspaceInput): Promise<string[]> {
  const { data } = input
  const made = await provision({
    name: input.name?.trim() || data.workspace.name,
    owner: input.owner,
    ownerName: input.ownerName,
    as: input.as,
    timeZone: data.workspace.timeZone,
  })
  const out = [...made.lines]
  const { workspaceId, adminId } = made
  const owner = await numberSetupActor(adminId, workspaceId)
  await run(
    'workspace.updateSettings',
    {
      recordingRetentionDays: RECORDINGS_NOT_KEPT,
      recordingNoticeOn: false,
      businessHoursOn: false,
      timeZone: data.workspace.timeZone,
      country: data.workspace.country,
      language: 'en',
    },
    owner,
  )
  await run('notifications.setDefaults', { email: false, browser: false }, owner)
  await run('workspace.setSpendingCap', { workspaceId, capUsd: data.workspace.spendingCapUsd }, adminOnServer(adminId))
  out.push(
    `Recordings not kept, no recording notice, no notification emails by default, spending cap $${data.workspace.spendingCapUsd} a month.`,
  )

  const existing = await db
    .select({ id: assistants.id, profile: assistants.business_profile })
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
  const pairs = pairAssistants(
    data.businesses,
    existing.map(a => ({ id: a.id, phone: a.profile.phone })),
  )
  const mapping: string[] = []
  for (const b of data.businesses) {
    let id = pairs.get(b.industry) ?? null
    if (!id) id = ((await run('assistant.create', { name: b.assistant }, owner)) as AssistantCreateData).assistantId
    await run('assistant.update', demoAssistantUpdate(id, b, data.demoRules), owner)
    out.push(`${b.industry}: ${b.business} (${id})`)
    mapping.push(`${b.industry}=${id}`)
  }
  const used = new Set(mapping.map(m => m.split('=')[1]))
  for (const a of existing.filter(a => !used.has(a.id)))
    out.push(`Note: assistant ${a.id} is not in the data file; it is left as it is.`)
  out.push(...(await leftovers(workspaceId)))
  out.push(`DEMO_WORKSPACE_ID=${workspaceId}`)
  out.push(`DEMO_ASSISTANTS=${mapping.join(',')}`)
  return out
}

/** What a demo workspace should not have, reported (never removed): numbers, calendars, webhooks, API keys. */
async function leftovers(workspaceId: string): Promise<string[]> {
  const count = async (
    table: typeof phone_numbers | typeof assistant_calendars | typeof webhook_endpoints | typeof api_keys,
  ) => (await db.select({ id: table.id }).from(table).where(eq(table.workspace_id, workspaceId))).length
  const found = {
    'phone numbers': await count(phone_numbers),
    calendars: await count(assistant_calendars),
    webhooks: await count(webhook_endpoints),
    'API keys': await count(api_keys),
  }
  return Object.entries(found)
    .filter(([, n]) => n > 0)
    .map(([what, n]) => `Warning: the demo workspace has ${n} ${what}; a public demo workspace should have none (demo calls are refused while it has a phone number, calendar or webhook).`)
}

async function main() {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      'owner-name': { type: 'string' },
      as: { type: 'string' },
      name: { type: 'string' },
      data: { type: 'string' },
    },
  })
  if (!values.owner)
    throw new Error(
      'Usage: demo:workspace --owner <email> [--owner-name <name>] [--as <server admin email>] [--name <workspace name>] [--data <file>]',
    )
  const data = await readDemoData(values.data ?? new URL('./demo-businesses.example.ts', import.meta.url).pathname)
  const lines = await setUpDemoWorkspace({
    owner: values.owner,
    ownerName: values['owner-name'],
    as: values.as,
    name: values.name,
    data,
  })
  for (const l of lines) console.log(l)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .catch(e => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => pool.end())
