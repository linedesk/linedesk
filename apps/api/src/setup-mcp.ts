// Setup MCP at /mcp/setup (LIN-125, docs/api.md "Setup MCP"): an AI agent (Claude, ChatGPT, Codex, Cursor, any MCP
// client, or curl) sets up the install for its instance admin. Authenticated with a setup key (agent-setup.ts), in the
// URL (/mcp/setup/<key>, for clients that cannot send headers: claude.ai, ChatGPT) or as Bearer. Stateless like /mcp.
//
// The tools: setup_status (what is done, the next step and how), providers_list, workspace_create, forwarding_guide,
// and the registry actions in SETUP_ACTIONS, run through runAction as the admin (same permissions and command log).
// Nothing else: no users, admins, other workspaces, keys, impersonation or deleting. Never email, sign-in or recording
// storage (whoever controls those can sign in as anyone or gets the recordings: the admin does them in the app), and
// the workspace actions run without instance:admin, so buying numbers keeps the caps of number-purchases.ts.
import {
  type ActionDef,
  actions,
  callAudioGuide,
  type ForwardingMode,
  type GroupStatus,
  forwardingInstructions,
  installPlace,
  isMultiCategory,
  LOCAL_INSTALL_NOTE,
  oneKey,
  type ProviderCategory,
  providerCategories,
  providerGroupIds,
  type ProviderName,
  providerSpec,
  recommendedProviders,
  SETUP_MCP_INSTRUCTIONS,
  searchForwardingGuides,
  statusText,
} from '@linedesk/actions'
import { assistants, member, organization, phone_numbers, user, workspace_settings } from '@linedesk/db'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { actorForSetupKey, setupKeyWithinLimit, tooManyRefusedSetupKeys, webAddress } from './agent-setup.ts'
import { changesSignInOrEmail } from './admin-step-up.ts'
import { auth } from './auth.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { goLiveChecklist } from './go-live-checklist.ts'
import { MCP_MAX_BODY_BYTES, guard, takeSlot, toolName } from './mcp.ts'
import { ensureWorkspaceRows } from './onboarding.ts'
import { providerStatus } from './provider-settings.ts'
import { runAction } from './run-action.ts'
import { setupChecklist } from './setup-checklist.ts'
import { recordSignup } from './setup-events.ts'

/**
 * The registry actions an agent gets, by name. Instance: the providers. Workspace: what onboarding does. Each is
 * still checked by runAction as the admin; this list only keeps everything else out of reach.
 */
export const SETUP_ACTIONS = [
  'provider.setKeys',
  'provider.setActive',
  'provider.test',
  'provider.connectOneKey',
  'provider.clearKeys',
  'business.search',
  'business.import',
  'workspace.rename',
  'workspace.setIcon',
  'workspace.removeIcon',
  'assistant.update',
  'workspace.updateSettings',
  'businessHours.set',
  'notifications.update',
  'phoneNumber.setup',
  'phoneNumber.update',
  'phoneNumber.lookupLine',
  'phoneNumber.checkForwarding',
  'phoneNumber.forwardingCheck',
  'onboarding.setStep',
] as const

/** Tools a client should confirm with the person first: they cost money or undo work. */
const ASK_FIRST: Record<string, string> = {
  'phoneNumber.setup':
    'With purchase: true this buys a phone number on the carrier account (about $1 a month on Telnyx): ask the admin first and say the cost. With purchase: false it attaches a number the account already has.',
  'provider.clearKeys': 'Removes the stored keys of a provider: ask the admin first.',
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
const answer = (data: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
})
const refusal = (error: string): ToolResult => ({ content: [{ type: 'text', text: error }], isError: true })

/** Provider categories the setup tools leave alone: email and sign-in (changesSignInOrEmail), and recording storage. */
const IN_APP_ONLY: readonly ProviderCategory[] = ['recording']
function inAppOnly(name: string, input: unknown): boolean {
  if (changesSignInOrEmail(name, input)) return true
  const fields = (input ?? {}) as { provider?: unknown; category?: unknown }
  const category =
    typeof fields.category === 'string'
      ? fields.category
      : typeof fields.provider === 'string' && name !== 'provider.test'
        ? (providerSpec(fields.provider as never)?.category ?? null)
        : null
  return (IN_APP_ONLY as readonly string[]).includes(category ?? '')
}
const IN_APP_ONLY_REFUSAL =
  'The setup tools do not change email, sign-in or recording storage: ask the admin to do this in the app (app_links.providers_email, providers_sign_in or providers_recording), then check it with provider_test.'

/** Instance admin rights only for the provider actions; the business's own actions run as its owner would. */
const actorFor = (name: string, actor: Actor): Actor =>
  name.startsWith('provider.')
    ? actor
    : { ...actor, permissions: actor.permissions.filter(p => p !== 'instance:admin') }

function registerAction(server: McpServer, def: ActionDef, actor: Actor) {
  const caution = ASK_FIRST[def.name]
  server.registerTool(
    toolName(def.name),
    {
      description: caution ? `${def.description} ${caution}` : def.description,
      inputSchema: def.input as never,
      annotations: { readOnlyHint: Boolean(def.readOnly), destructiveHint: Boolean(caution) },
    },
    ((input: unknown) =>
      guard(def.name, async () => {
        if (inAppOnly(def.name, input)) return refusal(IN_APP_ONLY_REFUSAL)
        const { body } = await runAction(def.name, input ?? {}, actorFor(def.name, actor))
        if (!body.ok) return refusal(body.error)
        return answer({ ok: true, rows: body.rows, ...(body.data ? { data: body.data } : {}) })
      })) as never,
  )
}

/** Links into the app for the steps only the admin can do there (a passkey, a test call with their microphone). */
const appLinks = () => {
  const app = webAddress()
  // One link per provider group (Admin › Providers scrolls to it): providers_email, providers_call_audio, …
  const groups = Object.fromEntries(
    providerGroupIds.map(id => [`providers_${id.replace('-', '_')}`, `${app}/#admin/providers/${id}`]),
  )
  return {
    app,
    setup: `${app}/#admin/overview`,
    providers: `${app}/#admin/providers`,
    ...groups,
    test_call: `${app}/#assistant`,
    onboarding: `${app}/`,
  }
}

type StepState = 'done' | 'todo' | 'failing' | 'admin_only'
/** `alias`: the id the step had before (LIN-158), for agents and notes that still use it. */
type Step = {
  id: string
  alias?: string
  label: string
  state: StepState
  detail?: string | null
  how?: readonly string[]
}

const GROUP_STATE: Record<GroupStatus['state'], StepState> = {
  works: 'done',
  failing: 'failing',
  missing: 'todo',
  partly: 'todo',
  checking: 'todo',
  untested: 'todo',
  not_needed: 'done',
  off: 'done',
}

/** One install step from a provider group, with how to do it when it is not done. */
function groupStep(group: GroupStatus, how: readonly string[], alias?: string): Step {
  const state = GROUP_STATE[group.state]
  const tested = group.state === 'untested' ? ['Keys are set but not tested: run provider_test.'] : []
  const word = statusText(group)
  return {
    id: group.id,
    ...(alias ? { alias } : {}),
    label: group.label,
    state,
    detail: [group.providerLabel, word, group.message].filter(Boolean).join(': '),
    ...(state === 'done' ? {} : { how: [...tested, ...how] }),
  }
}

/** How to set up one provider: its guide from the registry, written for an agent. */
const guideLines = (provider: ProviderName) => {
  const { label, category, guide } = providerSpec(provider)
  return [
    `${label} (provider "${provider}")${guide.url ? `, ${guide.url}` : ''}.`,
    // The guides are written for the app ("Paste it here"); an agent asks for the key instead.
    ...guide.steps.map(line => line.replace(/^Paste (it|both|them) here/, 'Ask the admin to paste $1 to you')),
    `Cost: ${guide.cost}`,
    `Store with provider_setKeys { provider: "${provider}", values: { <field>: <value> } } (fields: providers_list), then provider_setActive { category: "${category}", provider: "${provider}" } if another one is picked, then provider_test.`,
  ]
}
const callAudioLines = () => [
  'LiveKit and its SIP bridge carry the call audio; they run on this server.',
  ...callAudioGuide.steps,
  `Cost: ${callAudioGuide.cost}`,
  'If you cannot run commands on the server, tell the admin these steps.',
]

/** What the agent reads first and after every step. */
async function setupStatus(actor: Actor, { advance = true }: { advance?: boolean } = {}) {
  const { groups } = await setupChecklist(db)
  const group = (id: GroupStatus['id']) => groups.find(g => g.id === id)!
  const steps: Step[] = [
    groupStep(
      group('answering'),
      [
        'Two ways; ask the admin which they prefer.',
        `Simplest, one account: OpenAI (${oneKey.url}). ${oneKey.steps.slice(0, 2).join(' ')} Ask the admin to paste the key to you, then provider_connectOneKey { apiKey }. ${oneKey.cost} ${oneKey.caveat}`,
        'Best voice and every feature, three accounts (speech to text, language model, voice):',
        ...guideLines(recommendedProviders.stt),
        ...guideLines(recommendedProviders.llm),
        ...guideLines(recommendedProviders.tts),
      ],
      'ai',
    ),
    groupStep(group('telephony'), guideLines(recommendedProviders.telephony)),
    groupStep(group('email'), [
      ...guideLines(recommendedProviders.email),
      'The setup tools cannot change email: walk the admin through the account, then ask them to paste the key in the app (app_links.providers_email). Check it with provider_test.',
    ]),
    groupStep(group('call-audio'), callAudioLines(), 'livekit'),
    ...(await workspaceSteps(actor, advance)),
  ]
  const next = steps.find(s => s.state !== 'done' && s.state !== 'admin_only') ?? null
  return {
    you_act_as: await whoAmI(actor),
    install: whereItRuns(),
    steps: steps.map(({ how, ...s }) => (s.id === next?.id ? { ...s, how } : s)),
    next_step: next ? next.id : null,
    all_done: !next,
    app_links: appLinks(),
  }
}

/** Where the install runs: on a computer or a private network, carriers cannot reach it (LOCAL_INSTALL_NOTE). */
function whereItRuns() {
  const address = webAddress()
  const place = installPlace(address)
  return place === 'public' ? { address, public: true } : { address, public: false, place, note: LOCAL_INSTALL_NOTE }
}

/** The steps without their how-to, for the setup page in the app (GET /v1/admin/agent-setup), which shows the agent's progress. */
export async function setupProgress(actor: Actor) {
  const status = await setupStatus(actor, { advance: false })
  return {
    steps: status.steps.map(({ id, label, state }) => ({ id, label, state })),
    nextStep: status.next_step,
    allDone: status.all_done,
  }
}

async function whoAmI(actor: Actor) {
  const [me] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actor.actorId))
  return { name: me?.name ?? null, email: me?.email ?? null, role: 'instance admin' }
}

const STEP_ORDER = ['business', 'assistant', 'pickup', 'notify', 'phone', 'done'] as const
/** Whether onboarding has gone past `step` (the web app and onboarding_setStep move it). */
const past = (current: string | null | undefined, step: (typeof STEP_ORDER)[number]) =>
  current === 'done' ||
  current === 'skipped' ||
  STEP_ORDER.indexOf(current as (typeof STEP_ORDER)[number]) > STEP_ORDER.indexOf(step)

const BUSINESS_STEPS = [
  ['business', 'What the assistant knows about the business'],
  ['assistant', 'The assistant: name, greeting, voice'],
  ['pickup', 'When the assistant picks up'],
  ['notify', 'Who hears about calls'],
  ['phone', 'A phone number for the assistant'],
] as const

async function workspaceSteps(actor: Actor, advance: boolean): Promise<Step[]> {
  if (!actor.workspaceId)
    return [
      {
        id: 'workspace',
        label: 'The business (workspace)',
        state: 'todo',
        how: [
          "Ask for the business's name (and check its time zone).",
          'workspace_create { name, timeZone } makes it, with its assistant; the other business steps follow.',
        ],
      },
      // What follows once the business exists, so the admin sees the whole way from the start.
      ...BUSINESS_STEPS.map(([id, label]) => ({ id, label, state: 'todo' as const })),
    ]
  const workspaceId = actor.workspaceId
  const [ws] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, workspaceId))
  const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const [assistant] = await db
    .select()
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .orderBy(asc(assistants.created_at))
    .limit(1)
  const numbers = await db
    .select({ id: phone_numbers.id, e164: phone_numbers.e164, mode: phone_numbers.mode })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspaceId))
  const golive = await goLiveChecklist(db, actor)
  const profile = (assistant?.business_profile ?? {}) as Record<string, unknown>
  const hasProfile = Object.values(profile).some(v => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
  const forwarding = numbers.find(n => n.mode === 'forward_conditional' || n.mode === 'forward_all')
  // What is done follows the data, so an agent that saves a step without moving onboarding on still sees it done:
  // the assistant and who hears about calls are choices with defaults, passed once a later step is done.
  const step = settings?.onboarding_step
  const businessDone = hasProfile || past(step, 'business')
  const phoneDone = numbers.length > 0
  const pickupDone = Boolean(settings?.pickup_mode)
  const assistantDone = past(step, 'assistant') || pickupDone || phoneDone
  const notifyDone = past(step, 'notify') || phoneDone
  // Onboarding in the app resumes where the agent got to (never moved back): through the registry, as the admin. The
  // one write of reading the status: bookkeeping, nothing the admin would be asked about.
  const reached =
    phoneDone && businessDone && pickupDone
      ? 'done'
      : !businessDone
        ? null
        : !assistantDone
          ? 'assistant'
          : !pickupDone
            ? 'pickup'
            : !notifyDone
              ? 'notify'
              : 'phone'
  if (advance && reached && !past(step, reached) && step !== reached)
    await runAction('onboarding.setStep', { step: reached }, actorFor('onboarding.setStep', actor))
  const done = (yes: boolean): StepState => (yes ? 'done' : 'todo')
  return [
    {
      id: 'workspace',
      label: 'The business (workspace)',
      state: 'done',
      detail: `${ws?.name ?? ''} (${workspaceId}), time zone ${settings?.timezone ?? 'unknown'}, assistant ${assistant?.id ?? 'none'}`,
    },
    {
      id: 'business',
      label: 'What the assistant knows about the business',
      state: done(businessDone),
      how: [
        `business_search { query: "<name> <city>" } finds the listing (when business lookup is set up); business_import { assistantId: "${assistant?.id ?? ''}", placeId?, name?, website? } drafts a profile from the listing and the website. It changes nothing.`,
        'Show the admin a short summary (services, area, hours, what to say about prices), fix what they correct, then save it: assistant_update { assistantId, business_profile }. Opening hours: businessHours_set.',
        'Then onboarding_setStep { step: "assistant" }.',
      ],
    },
    {
      id: 'assistant',
      label: 'The assistant: name, greeting, voice',
      state: done(assistantDone),
      detail: assistant ? `${assistant.name}: "${assistant.greeting}"` : null,
      how: [
        `It is called ${assistant?.name ?? 'Maya'} and greets with "${assistant?.greeting ?? ''}". Ask whether to keep that; change it with assistant_update.`,
        'Then onboarding_setStep { step: "pickup" }.',
      ],
    },
    {
      id: 'pickup',
      label: 'When the assistant picks up',
      state: done(pickupDone),
      detail: settings?.pickup_mode ?? null,
      how: [
        'workspace_updateSettings { pickupMode }: "no_answer" (recommended: the business phone rings first, calls nobody takes go to the assistant), "after_hours" (only when closed; set the hours too), or "always".',
        'Then onboarding_setStep { step: "notify" }.',
      ],
    },
    {
      id: 'notify',
      label: 'Who hears about calls',
      state: done(notifyDone),
      how: [
        'Each call is summarized by email to the admin (notifications_update { email: true }).',
        "Urgent calls can be put through to a person: ask for a mobile number and save it in the assistant's transfers (assistant_update { assistantId, transfers }).",
        'Then onboarding_setStep { step: "phone" }.',
      ],
    },
    {
      id: 'phone',
      label: 'A phone number for the assistant',
      state: done(phoneDone),
      detail: numbers.map(n => `${n.e164} (${n.mode})`).join(', ') || null,
      how: [
        'Ask how calls should reach the assistant: keep the business number and forward to a new Linedesk number (mode "forward_conditional", or "forward_all" for every call), or a new number of its own (mode "new").',
        'phoneNumber_setup { areaCode, purchase: true, mode } buys one; say the cost and ask first. A number the carrier account already has: { e164, purchase: false, mode }.',
        'Then onboarding_setStep { step: "done" }.',
      ],
    },
    ...(forwarding
      ? [
          {
            id: 'forwarding',
            label: 'Forwarding from the business line',
            state: done(golive.forwardingVerified),
            how: [
              `Ask for the business line's carrier, then forwarding_guide { carrier, mode: "${forwarding.mode}" } for the codes to dial on the business phone (they forward to ${forwarding.e164}).`,
              `After the admin dialed them: phoneNumber_checkForwarding { phoneNumberId: "${forwarding.id}", businessNumber } calls the business line once; poll phoneNumber_forwardingCheck every few seconds while it says dialing.`,
            ],
          } satisfies Step,
        ]
      : []),
    {
      id: 'test_call',
      label: 'Hear the assistant',
      state: golive.firstRealCall ? 'done' : 'admin_only',
      how: [
        `The admin talks to the assistant in the browser (${appLinks().test_call} → Start test call) or calls the number from another phone.`,
      ],
    },
  ]
}

function registerTools(server: McpServer, actor: Actor) {
  const read = { readOnlyHint: true }
  server.registerTool(
    'setup_status',
    {
      description:
        'Start here, and call again after every step: what is set up, what is missing or failing, and for the next step exactly what to do (pages, clicks, tool calls). Also links into the app for what only the admin can do there.',
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => guard('setup_status', async () => answer(await setupStatus(actor))),
  )
  server.registerTool(
    'providers_list',
    {
      description:
        'The providers this install can use, by category (telephony, stt, llm, tts, realtime, email, sign_in, recording, business): their fields (name, whether secret, optional), which one is picked, which fields are set (never a value) and help text. Use the field names with provider_setKeys.',
      inputSchema: z.object({ category: z.enum(Object.keys(providerCategories) as [ProviderCategory]).optional() }),
      annotations: read,
    },
    async ({ category }) =>
      guard('providers_list', async () => {
        const status = await providerStatus(db)
        const rows = status.providers
          .filter(p => !category || p.category === category)
          .map(p => {
            const spec = providerSpec(p.provider)
            const fieldSpec = (field: string) =>
              (spec.fields as Record<string, { optional?: true; hint?: string }>)[field]
            return {
              provider: p.provider,
              label: p.label,
              category: p.category,
              picked: isMultiCategory(p.category) ? null : status.active[p.category]?.provider === p.provider,
              fields: p.fields.map(f => ({
                field: f.field,
                label: f.label,
                secret: f.secret,
                optional: Boolean(fieldSpec(f.field)?.optional),
                set: Boolean(f.source),
                hint: fieldSpec(f.field)?.hint ?? null,
              })),
              help: spec.help ?? null,
            }
          })
        return answer({ categories: providerCategories, providers: rows })
      }),
  )
  server.registerTool(
    'workspace_create',
    {
      description:
        "Create the admin's business (a workspace) with its assistant, when they have none yet. They become its owner. Then follow setup_status.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80).describe("The business's name, as callers know it"),
        timeZone: z.string().max(64).optional().describe('IANA time zone, e.g. America/Los_Angeles'),
      }),
    },
    async ({ name, timeZone }) =>
      guard('workspace_create', async () => {
        if (actor.workspaceId) return refusal('You already have a business here; set that one up (setup_status).')
        if (/[\r\n]/.test(name)) return refusal('the name is one line')
        const slug = `${name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`
        const org = await auth.api.createOrganization({ body: { name, slug, userId: actor.actorId } })
        if (!org) return refusal('could not create the workspace')
        await ensureWorkspaceRows(org.id, name, timeZone)
        await recordSignup(db, org.id)
        // The rest of this request's tools act in it.
        const [m] = await db
          .select({ role: member.role })
          .from(member)
          .where(and(eq(member.organizationId, org.id), eq(member.userId, actor.actorId)))
        actor.workspaceId = org.id
        if (m?.role === 'owner') actor.role = 'owner'
        return answer({ ok: true, workspace: { id: org.id, name: org.name }, next: 'Call setup_status.' })
      }),
  )
  server.registerTool(
    'forwarding_guide',
    {
      description:
        "How to forward the business line to the assistant's number: codes to dial (or settings to change) for the line's carrier or phone system, to turn forwarding on and off. Needs a number in a forwarding mode.",
      inputSchema: z.object({
        carrier: z
          .string()
          .trim()
          .min(2)
          .max(60)
          .describe('The business line\'s carrier or phone system, e.g. "Verizon", "RingCentral"'),
        mode: z.enum(['forward_conditional', 'forward_all']).default('forward_conditional'),
      }),
      annotations: read,
    },
    async ({ carrier, mode }) =>
      guard('forwarding_guide', async () => {
        if (!actor.workspaceId) return refusal('create the business first (workspace_create)')
        const [number] = await db
          .select({ e164: phone_numbers.e164 })
          .from(phone_numbers)
          .where(and(eq(phone_numbers.workspace_id, actor.workspaceId), eq(phone_numbers.mode, mode)))
          .limit(1)
        if (!number) return refusal(`no number in mode ${mode} yet: phoneNumber_setup first`)
        const guides = searchForwardingGuides(carrier).slice(0, 3)
        if (!guides.length)
          return refusal(`no guide for "${carrier}": ask for the carrier's name, or a mobile/landline/phone system`)
        return answer({
          forward_to: number.e164,
          guides: guides.map(guide => ({
            id: guide.id,
            name: guide.name,
            instructions: forwardingInstructions(guide, mode as ForwardingMode, number.e164),
          })),
        })
      }),
  )
  for (const name of SETUP_ACTIONS) {
    const def = actions.get(name)
    if (def) registerAction(server, def, actor)
  }
}

/** The setup tools for this setup key's admin. */
export function setupMcpServerFor(actor: Actor) {
  const server = new McpServer({ name: 'linedesk-setup', version: '1' }, { instructions: SETUP_MCP_INSTRUCTIONS })
  registerTools(server, actor)
  return server
}

const handler = createMcpHandler(ctx => setupMcpServerFor(ctx.authInfo!.extra!.actor as Actor), {
  responseMode: 'json',
  maxRequestBodySize: MCP_MAX_BODY_BYTES,
  onerror: e => console.error(`setup mcp: ${e.message}`),
})

const challenge = { 'www-authenticate': 'Bearer realm="linedesk-setup", error="invalid_token"' }
const refuse = (status: 400 | 401 | 405 | 413 | 429, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers })

/**
 * Serves one setup MCP request. The key comes from the path (/mcp/setup/<key>) or Bearer; an unknown, revoked or
 * expired key is a 401, and too many of them from one address a 429. One JSON-RPC message per request.
 */
export async function serveSetupMcp(request: Request, keyInPath: string | null, clientIp: string | null) {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const key = keyInPath || bearer
  if (!key)
    return refuse(
      401,
      'send the setup key: /mcp/setup/<key>, or Authorization: Bearer lds_… (Linedesk: Set up with an agent)',
      challenge,
    )
  // Blocked or not as the request came in; a working key gets in either way.
  const blocked = tooManyRefusedSetupKeys(clientIp)
  const actor = await actorForSetupKey(key, clientIp)
  if (!actor && blocked)
    return refuse(429, 'too many invalid setup keys from this address; try again later', { 'retry-after': '600' })
  if (!actor)
    return refuse(
      401,
      'unknown, ended or expired setup key: make a new one in Linedesk (Set up with an agent)',
      challenge,
    )
  if (!setupKeyWithinLimit(actor.setupKeyId!))
    return refuse(429, 'rate limit: try again in a minute', { 'retry-after': '60' })
  if (request.method !== 'POST') return refuse(405, 'send MCP messages with POST', { allow: 'POST' })
  const text = await request.text()
  if (text.length > MCP_MAX_BODY_BYTES) return refuse(413, 'request too large')
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    return refuse(400, 'the body must be one JSON-RPC message')
  }
  if (Array.isArray(message)) return refuse(400, 'JSON-RPC batches are not supported: send one message per request')
  const method = (message as { method?: unknown } | null)?.method
  if (method === 'subscriptions/listen') return refuse(400, `${method} is not supported`)
  const release = takeSlot(`setup:${actor.setupKeyId}`)
  if (!release) return refuse(429, 'at most 4 requests at once per setup key', { 'retry-after': '1' })
  try {
    const res = await handler.fetch(request, {
      parsedBody: message,
      authInfo: { token: 'setupkey', clientId: actor.actorId, scopes: [...actor.permissions], extra: { actor } },
    })
    const body = await res.text()
    release()
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch (e) {
    release()
    throw e
  }
}
