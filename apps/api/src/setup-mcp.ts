// Setup MCP at /mcp/setup (LIN-125, docs/api.md "Setup MCP"): an AI agent (Claude, ChatGPT, Codex, Cursor, any MCP
// client, or curl) sets up the install for its instance admin. Authenticated with a setup key (agent-setup.ts), in the
// URL (/mcp/setup/<key>, for clients that cannot send headers: claude.ai, ChatGPT) or as Bearer. Stateless like /mcp.
//
// The tools: setup_status (what is done, the next step and how: the server's steps once, each workspace's steps on
// their own), providers_list, workspace_create (one per business or location, as many as the admin runs),
// forwarding_guide, setup_endAccess (the agent ends its own link at the end, agentSetup.endOwnAccess), and the
// registry actions in SETUP_ACTIONS, run through runAction as the admin (same permissions and command log, marked as
// done with the setup key). Every business tool names its workspace (workspaceId) and runs only where the admin is
// owner or admin (setupActorIn, LIN-237). Nothing else: no users, admins, other people's workspaces, API keys,
// impersonation or deleting. Every provider key can be set here (LIN-182: the admin never pastes a key into the app); provider_setKeys
// runs the free provider test right after saving and returns it, and answers with "set" and the last 4 of a secret,
// never the secret. One access level: the key was made in a session that passed the admin's passkey check, so it sets
// email and sign-in too, with no second Allow step (Janik, 2026-11-15). The workspace actions run without instance:admin, so buying numbers keeps the caps of number-purchases.ts.
//
// A workspace owner's key (agent_setup_keys.workspace_id, agent-setup.ts) gets only that workspace's part: setup_status
// with that one workspace and no server steps, the business tools, forwarding_guide and setup_endAccess. Never
// providers_list, workspace_create or a provider or install action (not even registered), and its own instructions
// (SETUP_MCP_WORKSPACE_INSTRUCTIONS), which ask for no provider keys.
import {
  abroadWarning,
  type ActionDef,
  actions,
  callAudioGuide,
  type ForwardingMode,
  forwardingCountries,
  forwardingInstructions,
  guidesForCountry,
  hasForwardingCountry,
  OTHER_COUNTRY,
  type GroupStatus,
  installPlace,
  isMultiCategory,
  LOCAL_INSTALL_NOTE,
  oneKey,
  onboardingSteps,
  pipelineFor,
  pipelinesAllowed,
  type ProviderCategory,
  type ProviderName,
  providerCategories,
  providerGroupIds,
  providerGroups,
  providerSpec,
  REALTIME_VOICE_IDS,
  recommendedProviders,
  restartCategories,
  SETUP_MCP_INSTRUCTIONS,
  SETUP_MCP_WORKSPACE_INSTRUCTIONS,
  searchForwardingGuides,
  statusText,
  type SetupStepGroup,
  setupStepNames,
  type WorkspaceCreateData,
} from '@linedesk/actions'
import {
  assistants,
  calls,
  member_notification_settings,
  organization,
  phone_numbers,
  user,
  workspace_settings,
} from '@linedesk/db'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  type ManagedWorkspace,
  setupKeyAccess,
  setupWorkspaces,
  setupActorIn,
  setupKeyEndedResponse,
  tooManyRefusedSetupKeys,
  webAddress,
} from './agent-setup.ts'
import {
  mayCreateWorkspace,
  SETUP_LINK_CAP_TEXT,
  SETUP_LINK_WORKSPACE_CAP,
  WORKSPACE_CREATION_CLOSED,
  workspacesMadeBy,
} from './workspace-creation.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { goLiveChecklist } from './go-live-checklist.ts'
import { readInstallProgress } from './install-setup.ts'
import { guard, MCP_MAX_BODY_BYTES, takeSlot, toolName } from './mcp.ts'
import { newAssistant } from './onboarding.ts'
import { pipelinesSetUp, providerStatus, voicePipelinePolicy } from './provider-settings.ts'
import { runAction } from './run-action.ts'
import { setupChecklist } from './setup-checklist.ts'
import { workspaceLocale } from './workspace-locale.ts'
import { assistantSpokeIn } from './setup-events.ts'

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
  'provider.tryOut',
  'provider.confirmEmail',
  'install.setProgress',
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
  'provider.tryOut':
    'kind "email" sends one real email with a six-digit code to the admin\'s own address: ask them for the code, then provider_confirmEmail { code }. kind "telephony" lists numbers without buying any.',
}

/** What the agent is told about a tool on top of the registry's description. */
const EXTRA: Record<string, string> = {
  'provider.setKeys':
    'Ask the admin for the key in the chat and pass it here; never ask them to paste it into the app. The answer shows each field as set (secrets only by their last 4) and `test`: the free provider test run right after saving.',
  'install.setProgress':
    'The install part is marked finished by setup_status once its groups work; use this to skip a part the admin does not want now (skip: "<step>").',
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
/**
 * Messages from provider tests and errors are written for the app ("Enter a valid key under Server admin › Providers ›
 * Deepgram."). The agent stores keys itself, so they say what the agent does instead of sending the admin there.
 * Failures stored before the rename (provider_failures) still say "Admin › Providers" or "Admin, Providers": both match.
 */
export function forAgent(text: string): string {
  return text
    .replace(
      /Enter a (valid key|new client secret) under (?:Server admin|Admin) › Providers(?: › [^."]+)?\./g,
      (_, what: string) => `Ask the admin for a ${what} and store it again with provider_setKeys.`,
    )
    .replace(
      / under (?:Server admin|Admin) › Providers(?: › [^."]+)?\./g,
      ' with the admin, then store it again with provider_setKeys.',
    )
    .replace(
      /[Cc]onnect (it|email) in (?:Server admin|Admin)(?:, | › )Providers(?:(?:, | › )Email)?/g,
      'set up email with provider_setKeys',
    )
}
const answer = (data: Record<string, unknown>): ToolResult => {
  const text = forAgent(JSON.stringify(data))
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) }
}
// The setup link cap (SETUP_LINK_WORKSPACE_CAP) and its count: workspace-creation.ts. workspace.create enforces it in the
// creating transaction (workspace-creation-handlers.ts); the check here only answers early.
export { SETUP_LINK_WORKSPACE_CAP }

/**
 * One workspace_create per link at a time in this process, so the quick check below sees the previous call's committed
 * command (runAction returns after the commit). Across processes, workspace.create holds the line: it locks the link
 * and counts again in its own transaction.
 */
const creating = new Map<string, Promise<unknown>>()
function oneCreateAtATime<T>(keyId: string, run: () => Promise<T>): Promise<T> {
  const before = creating.get(keyId) ?? Promise.resolve()
  const next = before.catch(() => {}).then(run)
  const done = next.finally(() => {
    if (creating.get(keyId) === done) creating.delete(keyId)
  })
  creating.set(keyId, done)
  return next
}

const refusal = (error: string): ToolResult => ({ content: [{ type: 'text', text: forAgent(error) }], isError: true })

/** How often the agent reads setup_status while it waits for the admin (the test call). */
const POLL_SECONDS = 10

/** The server's own actions (providers, the install's progress): instance admin rights, in no workspace. */
const isServerAction = (name: string) => name.startsWith('provider.') || name.startsWith('install.')

/** What a business tool says when its workspace is not one the admin may set up (or does not exist). */
const NOT_YOUR_WORKSPACE =
  'That workspaceId is not one you can set up: use the id of one of setup_status.workspaces (workspaces where the admin is owner or admin). Nothing was changed.'

/** The workspace every business tool names: one of setup_status.workspaces. */
const workspaceIdField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('The workspace (business) this acts in: the id of one of setup_status.workspaces')

/** provider.setKeys through the agent: stored like in the app, then the free test, so the agent can react at once. */
async function saveAndTest(provider: ProviderName, actor: Actor, saved: Record<string, unknown>) {
  const { body } = await runAction('provider.test', { provider, free: true }, actor)
  const test = body.ok ? body.data : { ok: false, message: body.error }
  const restarts = restartCategories.includes(providerSpec(provider).category)
    ? 'Sign-in is read at start: the API restarts to apply this, a few seconds. Call setup_status again after that.'
    : null
  return answer({ ok: true, ...saved, test, ...(restarts ? { note: restarts } : {}) })
}

function registerAction(server: McpServer, def: ActionDef, actor: Actor) {
  const serverAction = isServerAction(def.name)
  const notes = [
    def.description,
    serverAction ? null : 'Pass workspaceId: the workspace (from setup_status.workspaces) this acts in.',
    EXTRA[def.name],
    ASK_FIRST[def.name],
  ].filter(Boolean)
  const caution = ASK_FIRST[def.name]
  // A business action names its workspace on top of its own fields (none of SETUP_ACTIONS has a workspaceId).
  const inputSchema = serverAction ? def.input : (def.input as z.ZodObject).extend({ workspaceId: workspaceIdField })
  server.registerTool(
    toolName(def.name),
    {
      description: notes.join(' '),
      inputSchema: inputSchema as never,
      annotations: { readOnlyHint: Boolean(def.readOnly), destructiveHint: Boolean(caution) },
    },
    ((raw: unknown) =>
      guard(def.name, async () => {
        let as: Actor | null = actor
        let input = raw ?? {}
        if (!serverAction) {
          // The business's own actions run as its owner or admin would, never with instance admin rights or the
          // passkey confirmation, and only in a workspace the admin is owner or admin of.
          const { workspaceId, ...rest } = input as { workspaceId: string }
          as = await setupActorIn(actor, workspaceId)
          if (!as) return refusal(NOT_YOUR_WORKSPACE)
          input = rest
        }
        const { body } = await runAction(def.name, input, as)
        if (!body.ok) return refusal(body.error)
        const result = { rows: body.rows, ...(body.data ? { data: body.data } : {}) }
        if (def.name === 'provider.setKeys')
          return saveAndTest((input as { provider: ProviderName }).provider, as, result)
        return answer({ ok: true, ...result })
      })) as never,
  )
}

/** Links into the app for the steps only the admin can do there (a test call with their microphone, forwarding). */
const appLinks = (actor: Actor) => {
  const app = webAddress()
  // A workspace owner's link: their setup page and the app, nothing of Server admin.
  if (actor.setupWorkspaceId)
    return { app, agent_setup: `${app}/#setup-agent`, test_call: `${app}/#setup-agent`, onboarding: `${app}/` }
  // One link per provider group (Server admin › Providers scrolls to it): providers_email, providers_call_audio, …
  const groups = Object.fromEntries(
    providerGroupIds.map(id => [`providers_${id.replace('-', '_')}`, `${app}/#admin/providers/${id}`]),
  )
  return {
    app,
    setup: `${app}/#admin/overview`,
    // The setup page: the admin's own steps (forwarding, the test call), and End access.
    agent_setup: `${app}/#setup-agent`,
    providers: `${app}/#admin/providers`,
    ...groups,
    // The test call is made on the setup page too ("Call <assistant> now" on its row), so the admin stays there.
    test_call: `${app}/#setup-agent`,
    onboarding: `${app}/`,
  }
}

type StepState = 'done' | 'todo' | 'failing' | 'admin_only'
/** `alias`: the id the step had before (LIN-158), for agents and notes that still use it. */
type StepBase = {
  id: string
  alias?: string
  label: string
  hint?: string
  state: StepState
  detail?: string | null
  how?: readonly string[]
}
/** `group`: which part of the setup the step belongs to: the admin's own, the server's or the business's. */
type Step = StepBase & { group: SetupStepGroup }

/**
 * The steps of one part of the setup, tagged with it; `group` comes right after the label in the agent's output. Each
 * is named as on the setup page (setupStepNames: the app's own place for it, plus a hint where it helps).
 */
const inGroup = (group: SetupStepGroup, steps: StepBase[]): Step[] =>
  steps.map(({ id, alias, label, hint, ...rest }) => {
    const named = setupStepNames[id]
    const words = named?.hint ?? hint
    return {
      id,
      ...(alias ? { alias } : {}),
      label: named?.label ?? label,
      ...(words ? { hint: words } : {}),
      group,
      ...rest,
    }
  })

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
function groupStep(group: GroupStatus, how: readonly string[], alias?: string): StepBase {
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
    `Store with provider_setKeys { provider: "${provider}", values: { <field>: <value> } } (fields: providers_list); it runs the free test right away and returns it as \`test\`. Then provider_setActive { category: "${category}", provider: "${provider}" } if another one is picked.`,
  ]
}
/** Not on a public address (a test install): a number without a carrier, for trying it out. */
export const devNumberLine = () =>
  whereItRuns().public
    ? []
    : [
        'For a test without a carrier, set TELEPHONY_PROVIDER=dev in .env and restart the API: you get a simulated number.',
      ]
const callAudioLines = () => [
  'LiveKit and its SIP bridge carry the call audio; they run on this server.',
  ...callAudioGuide.steps,
  `Cost: ${callAudioGuide.cost}`,
  'If you cannot run commands on the server, tell the admin these steps.',
]

/** The install's own steps (provider groups a first call needs); when all are done, the setup by hand is finished. */
const INSTALL_GROUP_STEPS: readonly string[] = ['answering', 'telephony', 'email', 'call-audio']

/** Whether the install's own part is done: its provider steps by id. */
export const installPartDone = (steps: readonly Pick<Step, 'id' | 'state'>[]) =>
  steps.filter(s => INSTALL_GROUP_STEPS.includes(s.id)).every(s => s.state === 'done')

/** One workspace's steps for the agent, with its id: every business tool takes it as workspaceId. */
type WorkspaceStatus = { id: string | null; name: string | null; role?: ManagedWorkspace['role']; steps: Step[] }

/** The first step still to do (not done, not the admin's own). */
const firstOpen = (steps: readonly Step[]) => steps.find(s => s.state !== 'done' && s.state !== 'admin_only') ?? null

/** What the agent reads first and after every step. */
async function setupStatus(actor: Actor, { advance = true }: { advance?: boolean } = {}) {
  const { groups } = await setupChecklist(db)
  const group = (id: GroupStatus['id']) => groups.find(g => g.id === id)!
  // A workspace owner's link: that workspace's part only.
  if (actor.setupWorkspaceId) return workspaceSetupStatus(actor, groups, advance)
  // Once per server: the providers a first call needs. The admin's passkey is no step: making the setup link needed it.
  const steps: Step[] = [
    ...inGroup('server', [
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
      groupStep(group('telephony'), [...guideLines(recommendedProviders.telephony), ...devNumberLine()]),
      groupStep(group('email'), [
        ...guideLines(recommendedProviders.email),
        'Ask for the From address too (an address on the domain verified with the mail service) and store it with the key: values { api_key, from }.',
        'Once the test passes: provider_tryOut { kind: "email" } sends a six-digit code to the admin\'s own address; ask them for it in the chat and call provider_confirmEmail { code }. That proves delivery end to end.',
      ]),
      groupStep(group('call-audio'), callAudioLines(), 'livekit'),
    ]),
  ]
  // Then each workspace the admin may set up, one after the other (oldest first); none yet: how to make the first.
  const workspaces = await workspaceStatuses(actor, advance)
  // The install's own part is done: the setup by hand does not open on it later (bookkeeping, like onboarding_setStep).
  if (advance && installPartDone(steps) && !(await readInstallProgress()).finishedAt)
    await runAction('install.setProgress', { finished: true }, actor)
  const serverNext = firstOpen(steps)
  const nextWorkspace = serverNext ? null : (workspaces.find(w => firstOpen(w.steps)) ?? null)
  const next = serverNext ?? (nextWorkspace ? firstOpen(nextWorkspace.steps) : null)
  const waiting = [...steps, ...workspaces.flatMap(w => w.steps)].filter(s => s.state === 'admin_only')
  // The next step's how-to, and those of the admin's own steps while open (the test calls).
  const shown = (list: Step[], here: boolean) =>
    list.map(({ how, ...s }) => ((here && s.id === next?.id) || s.state === 'admin_only' ? { ...s, how } : s))
  return {
    you_act_as: await whoAmI(actor),
    install: whereItRuns(),
    // The server's steps, once per install.
    steps: shown(steps, Boolean(serverNext)),
    // Each workspace's own steps; pass its id as workspaceId to every business tool for it.
    workspaces: workspaces.map(w => ({
      ...w,
      steps: shown(w.steps, w === nextWorkspace),
      all_done: !firstOpen(w.steps),
    })),
    next_step: next ? next.id : null,
    // The workspace the next step is in (null: a server step, or the first workspace still has to be made).
    next_workspace_id: nextWorkspace?.id ?? null,
    all_done: !next,
    // How to finish, ending this setup link with setup_endAccess.
    wrap_up: wrapUp(!next, waiting),
    optional: optionalSteps(groups),
    app_links: appLinks(actor),
  }
}

/** The groups of the server a first call needs (INSTALL_GROUP_STEPS), all working: calls can be answered. */
const serverReady = (groups: readonly GroupStatus[]) =>
  INSTALL_GROUP_STEPS.every(id => {
    const group = groups.find(g => g.id === id)
    return group ? GROUP_STATE[group.state] === 'done' : false
  })

/**
 * setup_status for a workspace owner's link: no server steps (they are the server admin's), only whether the server
 * can answer calls yet (server_ready), and the one workspace's steps. Nothing about the install is noted.
 */
async function workspaceSetupStatus(actor: Actor, groups: readonly GroupStatus[], advance: boolean) {
  const workspaces = await workspaceStatuses(actor, advance)
  const nextWorkspace = workspaces.find(w => firstOpen(w.steps)) ?? null
  const next = nextWorkspace ? firstOpen(nextWorkspace.steps) : null
  const waiting = workspaces.flatMap(w => w.steps).filter(s => s.state === 'admin_only')
  const shown = (list: Step[]) =>
    list.map(({ how, ...s }) => (s.id === next?.id || s.state === 'admin_only' ? { ...s, how } : s))
  return {
    you_act_as: await whoAmI(actor),
    server_ready: serverReady(groups),
    steps: [],
    workspaces: workspaces.map(w => ({ ...w, steps: shown(w.steps), all_done: !firstOpen(w.steps) })),
    next_step: next ? next.id : null,
    next_workspace_id: nextWorkspace?.id ?? null,
    all_done: !next,
    wrap_up: wrapUp(!next, waiting, { oneWorkspace: true }),
    app_links: appLinks(actor),
  }
}

/** The steps of every workspace the admin may set up; without one yet, the way to the first (workspace_create). */
async function workspaceStatuses(actor: Actor, advance: boolean): Promise<WorkspaceStatus[]> {
  const mine = await setupWorkspaces(actor)
  // A workspace key whose owner lost the workspace meanwhile: nothing to set up (the next request is refused).
  if (!mine.length && actor.setupWorkspaceId) return []
  if (!mine.length) return [{ id: null, name: null, steps: inGroup('business', noWorkspaceSteps()) }]
  const out: WorkspaceStatus[] = []
  for (const ws of mine) out.push(await workspaceStatus(actor, ws, advance))
  return out
}

async function workspaceStatus(actor: Actor, ws: ManagedWorkspace, advance: boolean): Promise<WorkspaceStatus> {
  const inWs = await setupActorIn(actor, ws.id)
  const steps = inWs ? await workspaceSteps(inWs, advance) : []
  return { id: ws.id, name: ws.name, role: ws.role, steps: inGroup('business', steps) }
}

/**
 * How the agent finishes: a short summary, then setup_endAccess as its last call. With a test call still open, the
 * admin makes it on the setup page first; with other steps open, the agent asks before ending its access.
 */
export function wrapUp(
  agentDone: boolean,
  waiting: readonly Pick<Step, 'id'>[],
  { oneWorkspace = false }: { oneWorkspace?: boolean } = {},
): string {
  const end =
    'then call setup_endAccess as your last call: this setup link stops working at once, and the setup page tells the admin you ended it.'
  if (!agentDone)
    return `Not finished yet. If you stop before every step is done, ask the admin first whether to end your access; if they agree, give a short summary of what is set up and what is left, ${end}`
  const open = [...new Set(waiting.map(s => s.id))]
  if (open.includes('test_call') && oneWorkspace)
    return `Your part is done. Ask the owner to make the test call now, right on the setup page (${webAddress()}/#setup-agent): the button on its Test call row calls the assistant with their microphone. Call setup_status { read_only: true } every ${POLL_SECONDS} seconds or when they say they are done, until test_call is done (or they want to skip it). Then give a short summary of what is set up and what is left for them, ${end}`
  if (open.includes('test_call'))
    return `Your part is done. Ask the admin to make the test call now, right on the setup page (${webAddress()}/#setup-agent): they pick the workspace in the dropdown above its steps, and the button on its Test call row calls that workspace's assistant with their microphone (once per workspace whose test_call is open). Call setup_status { read_only: true } every ${POLL_SECONDS} seconds or when they say they are done, until test_call is done (or they want to skip it). Then give a short summary of what is set up and what is left for them, ${end}`
  if (open.length)
    return `Your part is done; only the admin can do what is still open (${open.join(', ')}). Give a short summary of what is set up and what is left for them, ask whether to end your access now, and if they agree, ${end}`
  return `Everything is set up. Give the admin a short summary of what is set up in each workspace and what is left for them (the optional steps), ${end}`
}

/** Where an OAuth app sends people back to: the same list as the provider's dialog (web ProviderLogo.tsx). */
function redirectUris(provider: ProviderName): string[] {
  const app = webAddress()
  if (provider === 'google' || provider === 'microsoft')
    return [`${app}/api/auth/callback/${provider}`, `${app}/v1/calendar/callback/${provider}`]
  if (provider === 'github') return [`${app}/api/auth/callback/github`]
  if (provider === 'oidc') return [`${app}/api/auth/oauth2/callback/oidc`]
  return []
}

/**
 * The groups a first call does not need (sign-in, calendar, recording, business lookup): their state and how to set
 * them up through these tools, offered once the needed steps are done. Calendars themselves are connected per business
 * by signing in to Google or Microsoft in the browser (Assistant settings › Booking & calendar), the one part an agent cannot do.
 */
function optionalSteps(groups: GroupStatus[]) {
  const how: Record<string, string[]> = {
    'sign-in': [
      ...guideLines(recommendedProviders.sign_in),
      'The OAuth app needs the redirect URIs that providers_list gives per provider (redirect_uris).',
    ],
    calendar: [
      'The Google or Microsoft sign-in app also connects calendars (set it up as for sign-in, with the calendar scopes in its help).',
      `Connecting a calendar to the business is a Google or Microsoft sign-in in the browser: the admin does it in ${webAddress()}/#assistant/booking after setup. Say so; it is optional.`,
    ],
    recording: [
      'Local disk is the simplest: provider_setActive { category: "recording", provider: "file" } and, on the server, docker compose --profile recording up -d (if you can run commands there, do it).',
      ...guideLines('s3'),
    ],
    business: guideLines(recommendedProviders.business),
  }
  return providerGroups
    .filter(g => !g.needed)
    .map(spec => {
      const group = groups.find(g => g.id === spec.id)
      const state = group ? GROUP_STATE[group.state] : 'todo'
      return {
        id: spec.id,
        label: spec.label,
        why: spec.why,
        state: group?.state === 'off' ? 'off' : state,
        ...(group?.state === 'works' ? {} : { how: how[spec.id] ?? [] }),
      }
    })
}

/** Where the install runs: on a computer or a private network, carriers cannot reach it (LOCAL_INSTALL_NOTE). */
function whereItRuns() {
  const address = webAddress()
  const place = installPlace(address)
  return place === 'public' ? { address, public: true } : { address, public: false, place, note: LOCAL_INSTALL_NOTE }
}

/**
 * The steps without their how-to, for the setup page in the app (GET /v1/admin/agent-setup, and for a workspace
 * owner GET /v1/workspace/agent-setup: their one workspace's steps only), which shows the agent's
 * progress: the server's steps, then those of one workspace, `selected` when the admin may set it up, else their
 * first. `workspaces` lists every one they may set up, with how far each got (the page's dropdown).
 */
export async function setupProgress(actor: Actor, selected?: string | null) {
  const status = await setupStatus(actor, { advance: false })
  // A workspace owner's page always has its one workspace (the route checks the owner); none only if it just went.
  const chosen: WorkspaceStatus = status.workspaces.find(w => w.id && w.id === selected) ??
    status.workspaces[0] ?? { id: null, name: null, steps: [] }
  const steps = [...status.steps, ...chosen.steps]
  const next = firstOpen(steps)
  const assistant = chosen.id ? await firstAssistant(chosen.id) : null
  return {
    steps: steps.map(({ id, label, hint, group, state }) => ({
      id,
      label,
      ...(hint ? { hint } : {}),
      group,
      state,
    })),
    nextStep: next?.id ?? null,
    allDone: !next,
    workspaces: status.workspaces.flatMap(w =>
      w.id
        ? [
            {
              id: w.id,
              name: w.name ?? '',
              done: w.steps.filter(s => s.state === 'done').length,
              total: w.steps.length,
            },
          ]
        : [],
    ),
    workspace: chosen.id ? { id: chosen.id, name: chosen.name ?? '', assistantName: assistant?.name ?? 'Maya' } : null,
  }
}

/** The business's first assistant: the one the setup sets up and the test call talks to. */
async function firstAssistant(workspaceId: string) {
  const [assistant] = await db
    .select()
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .orderBy(asc(assistants.created_at))
    .limit(1)
  return assistant
}

/**
 * Whether the business's assistant answered a browser test call (the voice agent files it with source "test"): it said
 * something. A test call the agent could not answer (providers not set up: a missed call) does not count.
 */
async function testCallMade(workspaceId: string): Promise<boolean> {
  // The same rule as the "Heard the assistant" milestone (setup-events.ts).
  const [call] = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), eq(calls.source, 'test'), assistantSpokeIn(calls.id)))
    .limit(1)
  return Boolean(call)
}

async function whoAmI(actor: Actor) {
  const [me] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actor.actorId))
  return {
    name: me?.name ?? null,
    email: me?.email ?? null,
    role: actor.setupWorkspaceId ? 'workspace owner' : 'instance admin',
  }
}

/**
 * Whether onboarding has gone past `step` (the web app and onboarding_setStep move it). "Finish later" (`skipped`) is
 * past nothing: the owner left onboarding without setting anything up, so what is done follows the data alone.
 */
export const past = (current: string | null | undefined, step: (typeof onboardingSteps)[number]) =>
  current === 'done' ||
  onboardingSteps.indexOf(current as (typeof onboardingSteps)[number]) > onboardingSteps.indexOf(step)

/** With the realtime model the assistant picks one of the model's voices (`realtime_voice`); '' is the server's default. */
const REALTIME_VOICE_NOTE = `Voice: one of the realtime model's voices, per assistant (assistant_update realtime_voice: ${REALTIME_VOICE_IDS.join(', ')}; empty for the server's default)`
const assistantStepLabel = (realtime: boolean) =>
  realtime ? 'The assistant: name and greeting' : 'The assistant: name, greeting, voice'

/** The default assistant's name (assistants.name). */
const DEFAULT_ASSISTANT_NAME = 'Maya'
/** The transfer contact the notify step of onboarding saves (URGENT_CONTACT_ID, apps/web/src/onboarding/flow.ts). */
const URGENT_CONTACT_ID = 'urgent'

const BUSINESS_STEPS = [
  ['business', 'What the assistant knows about the business'],
  ['assistant', 'The assistant: name, greeting, voice'],
  ['pickup', 'When the assistant picks up'],
  ['notify', 'Who hears about calls'],
  ['phone', 'A phone number for the assistant'],
] as const

/** Before the admin has a workspace: how to make the first, and what follows, so they see the whole way from the start. */
const noWorkspaceSteps = (): StepBase[] => [
  {
    id: 'workspace',
    label: 'The business (workspace)',
    state: 'todo',
    how: [
      "Ask for the business's name (and check its time zone). Ask once whether they run more than one business or location: each gets its own workspace.",
      'workspace_create { name, timeZone } makes it, with its assistant, and returns its id; the other business steps follow in setup_status.workspaces.',
    ],
  },
  ...BUSINESS_STEPS.map(([id, label]) => ({ id, label, state: 'todo' as const })),
]

/** One workspace's steps; `actor` acts in it as its owner or admin (setupActorIn). */
async function workspaceSteps(actor: Actor, advance: boolean): Promise<StepBase[]> {
  const workspaceId = actor.workspaceId!
  // Every business tool names this workspace.
  const w = `workspaceId: "${workspaceId}"`
  const [ws] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, workspaceId))
  const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const assistant = await firstAssistant(workspaceId)
  const locale = await workspaceLocale(db, workspaceId, settings ?? null)
  const numbers = await db
    .select({ id: phone_numbers.id, e164: phone_numbers.e164, mode: phone_numbers.mode })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspaceId))
  const golive = await goLiveChecklist(db, actor)
  const profile = (assistant?.business_profile ?? {}) as Record<string, unknown>
  const hasProfile = Object.values(profile).some(v => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
  const forwarding = numbers.find(n => n.mode === 'forward_conditional' || n.mode === 'forward_all')
  // What is done follows the data, so an agent that saves a step without moving onboarding on still sees it done; a
  // step onboarding went past (not "Finish later") is done too. The assistant and who hears about calls are choices
  // with defaults: done once changed.
  const step = settings?.onboarding_step
  const businessDone = hasProfile || past(step, 'business')
  const phoneDone = numbers.length > 0
  const pickupDone = Boolean(settings?.pickup_mode)
  const fresh = newAssistant(workspaceId, ws?.name ?? '')
  const assistantChanged =
    !!assistant && (assistant.name !== DEFAULT_ASSISTANT_NAME || assistant.greeting !== fresh.greeting)
  const assistantDone = assistantChanged || past(step, 'assistant')
  const [notifyRow] = await db
    .select({ user_id: member_notification_settings.user_id })
    .from(member_notification_settings)
    .where(eq(member_notification_settings.workspace_id, workspaceId))
    .limit(1)
  // The "Who hears about calls?" step saves a member's notifications and its own transfer contact (id "urgent",
  // URGENT_CONTACT_ID in apps/web/src/onboarding/flow.ts).
  const notifyDone =
    !!notifyRow || !!assistant?.transfers.some(t => t.id === URGENT_CONTACT_ID) || past(step, 'notify')
  // With the realtime model the assistant speaks in the server's voice, not one it picks (like Assistant settings).
  const policy = await voicePipelinePolicy(db)
  const realtime =
    pipelineFor(assistant?.voice_pipeline, pipelinesAllowed(await pipelinesSetUp(db), policy)) === 'realtime'
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
  // A workspace whose owner chose "Finish later" stays so: the app does not reopen onboarding behind their back.
  if (advance && reached && step !== 'skipped' && !past(step, reached) && step !== reached)
    await runAction('onboarding.setStep', { step: reached }, actor)
  const done = (yes: boolean): StepState => (yes ? 'done' : 'todo')
  return [
    {
      id: 'workspace',
      label: 'The business (workspace)',
      state: 'done',
      // The name is a member's text: quoted, as data.
      detail: `${JSON.stringify(ws?.name ?? '')} (${workspaceId}), time zone ${settings?.timezone ?? 'unknown'}, country ${locale.resolvedCountry}${locale.country ? '' : ` (automatic, ${locale.countrySource})`}, language ${locale.resolvedLanguage}${locale.language ? '' : ' (automatic, from the country)'}, assistant ${assistant?.id ?? 'none'}`,
      how: [
        `Check the country and language with the admin: workspace_updateSettings { ${w}, country: "US", language: "en" } (ISO country code and one of the listed language codes; null: automatic). The country is the default for phone numbers, the forwarding guide, holidays and currency, and the region numbers callers say are read in; the language is what the assistant greets in (unless it has its own main language) and what call summaries are written in.`,
      ],
    },
    {
      id: 'business',
      label: 'What the assistant knows about the business',
      state: done(businessDone),
      how: [
        `business_search { ${w}, query: "<name> <city>" } finds the listing (when business lookup is set up); business_import { ${w}, assistantId: "${assistant?.id ?? ''}", placeId?, name?, website? } drafts a profile from the listing and the website. It changes nothing.`,
        `Show the admin a short summary (services, area, hours, what to say about prices), fix what they correct, then save it: assistant_update { ${w}, assistantId, business_profile }. Opening hours: businessHours_set { ${w}, … }.`,
        `Then onboarding_setStep { ${w}, step: "assistant" }.`,
      ],
    },
    {
      id: 'assistant',
      label: assistantStepLabel(realtime),
      state: done(assistantDone),
      detail: assistant
        ? `${JSON.stringify(assistant.name)}: ${JSON.stringify(assistant.greeting)}${realtime ? `. ${REALTIME_VOICE_NOTE}` : ''}`
        : null,
      how: [
        // Quoted: the name and greeting are a member's text, put into the agent's instructions as data.
        `It is called ${JSON.stringify(assistant?.name ?? 'Maya')} and greets with ${JSON.stringify(assistant?.greeting ?? '')}. Ask whether to keep that; change it with assistant_update { ${w}, assistantId, … }.`,
        ...(realtime ? [`${REALTIME_VOICE_NOTE}: calls are answered by the realtime model, in that voice.`] : []),
        `Then onboarding_setStep { ${w}, step: "pickup" }.`,
      ],
    },
    {
      id: 'pickup',
      label: 'When the assistant picks up',
      state: done(pickupDone),
      detail: settings?.pickup_mode ?? null,
      how: [
        `workspace_updateSettings { ${w}, pickupMode }: "no_answer" (recommended: the business phone rings first, calls nobody takes go to the assistant), "after_hours" (business hours on: outside them the assistant says when you open; calls missed while open reach it too), or "always".`,
        `Then onboarding_setStep { ${w}, step: "notify" }.`,
      ],
    },
    {
      id: 'notify',
      label: 'Who hears about calls',
      state: done(notifyDone),
      how: [
        `Each call is summarized by email to the admin (notifications_update { ${w}, email: true }).`,
        `Urgent calls can be put through to a person: ask for a mobile number and save it in the assistant's transfers (assistant_update { ${w}, assistantId, transfers }).`,
        `Then onboarding_setStep { ${w}, step: "phone" }.`,
      ],
    },
    {
      id: 'phone',
      label: 'A phone number for the assistant',
      state: done(phoneDone),
      // The id too: the forwarding tools need it, also while another step is next and this one has no `how`.
      detail: numbers.map(n => `${n.e164} (${n.mode}, phoneNumberId ${n.id})`).join(', ') || null,
      how: [
        'Ask how calls should reach the assistant: keep the business number and forward to a new Linedesk number (mode "forward_conditional", or "forward_all" for every call), or a new number of its own (mode "new").',
        `phoneNumber_setup { ${w}, areaCode, purchase: true, mode } buys one; say the cost and ask first. A number the carrier account already has: { ${w}, e164, purchase: false, mode }.`,
        `Then onboarding_setStep { ${w}, step: "done" }.`,
      ],
    },
    ...(forwarding
      ? [
          {
            id: 'forwarding',
            label: 'Forwarding from the business line',
            state: done(golive.forwardingVerified),
            how: [
              `Ask for the business line's carrier, then forwarding_guide { ${w}, carrier, country, mode: "${forwarding.mode}" } (country: where the business line is, e.g. "US") for the codes to dial on the business phone (they forward to ${forwarding.e164}).`,
              `After the admin dialed them: phoneNumber_checkForwarding { ${w}, phoneNumberId: "${forwarding.id}", businessNumber } calls the business line once; poll phoneNumber_forwardingCheck { ${w}, … } every few seconds while it says dialing.`,
              actor.setupWorkspaceId
                ? `The owner can also do all of it on the setup page (${webAddress()}/#setup-agent): "Set up forwarding" on the Call forwarding row shows the codes for their carrier and runs the same check.`
                : `The admin can also do all of it on the setup page (${webAddress()}/#setup-agent): with this workspace picked in the dropdown, "Set up forwarding" on the Call forwarding row shows the codes for their carrier and runs the same check.`,
            ],
          } satisfies StepBase,
        ]
      : []),
    {
      id: 'test_call',
      label: 'Hear the assistant',
      // Done once the admin talked to the assistant (a browser test call, from the setup page or the app) or a real
      // caller got through. Only the admin can do it: they talk.
      state: golive.firstRealCall || (await testCallMade(workspaceId)) ? 'done' : 'admin_only',
      how: [
        `Only the ${actor.setupWorkspaceId ? 'owner' : 'admin'} can do this: they talk to the assistant. Ask them to stay on the setup page (${webAddress()}/#setup-agent)${actor.setupWorkspaceId ? '' : `, pick ${JSON.stringify(ws?.name ?? '')} in the workspace dropdown`} and click ${JSON.stringify(`Call ${assistant?.name ?? 'Maya'} now`)} on the Test call row: it calls the assistant with their microphone, right there, and the step is done once the assistant answered.${numbers[0] ? ` Or they call ${numbers[0].e164} from another phone.` : ''}`,
        `Call setup_status { read_only: true } every ${POLL_SECONDS} seconds or when they say they talked to it, until test_call is done.`,
      ],
    },
  ]
}

function registerTools(server: McpServer, actor: Actor) {
  const read = { readOnlyHint: true }
  // A workspace owner's link: no server tools at all, only the workspace's (agent-setup.ts).
  const serverTools = !actor.setupWorkspaceId
  server.registerTool(
    'setup_status',
    {
      description:
        'Start here, and call again after every step: what is set up, what is missing or failing, and for the next step exactly what to do (pages, clicks, tool calls). Also links into the app for what only the admin can do there. It never changes a setting; it only notes how far the setup got (the step the app opens on). With read_only: true it notes nothing either: use that to wait.',
      inputSchema: z.object({
        read_only: z
          .boolean()
          .optional()
          .describe("true: only read, note nothing (for waiting, e.g. for the admin's test call)"),
      }),
      annotations: read,
    },
    async (input: { read_only?: boolean }) =>
      guard('setup_status', async () => answer(await setupStatus(actor, { advance: !input?.read_only }))),
  )
  if (serverTools) server.registerTool(
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
              ...(spec.category === 'sign_in' ? { redirect_uris: redirectUris(p.provider) } : {}),
            }
          })
        return answer({ categories: providerCategories, providers: rows })
      }),
  )
  if (serverTools) server.registerTool(
    'workspace_create',
    {
      description: `Create a business (a workspace) with its assistant: one per business or location the admin runs (this setup link makes at most ${SETUP_LINK_WORKSPACE_CAP}). They become its owner. Ask for the name first; never make the same business twice (setup_status.workspaces lists the ones there are). Returns its id: pass it as workspaceId to the business tools, then follow setup_status. Only for businesses the admin runs themselves: a business for someone else is created in Server admin › Workspaces › New workspace with its owner's email.`,
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80).describe("The business's name, as callers know it"),
        timeZone: z.string().max(64).optional().describe('IANA time zone, e.g. America/Los_Angeles'),
      }),
    },
    async ({ name, timeZone }) =>
      guard('workspace_create', async () => {
        if (/[\r\n]/.test(name)) return refusal('the name is one line')
        // Only server admins create workspaces (workspace-creation.ts): a setup link is a server admin's.
        if (!mayCreateWorkspace(actor)) return refusal(WORKSPACE_CREATION_CLOSED)
        const keyId = actor.setupKeyId
        if (!keyId) return refusal('could not create the workspace')
        // The one path for a new workspace (workspace.create without an owner: the admin becomes its owner), logged with
        // this link like every setup tool. A refusal is said as it is, never "internal error".
        const made = await oneCreateAtATime(keyId, async () => {
          // A leaked link must not fill the install with workspaces: the command log counts what it made.
          if ((await workspacesMadeBy(db, keyId)) >= SETUP_LINK_WORKSPACE_CAP) return 'link_cap' as const
          return runAction('workspace.create', { name, ...(timeZone ? { timeZone } : {}) }, actor)
        })
        if (made === 'link_cap') return refusal(SETUP_LINK_CAP_TEXT)
        if (!made.body.ok) return refusal(made.body.error)
        const org = (made.body.data as WorkspaceCreateData).workspace
        return answer({
          ok: true,
          workspace: { id: org.id, name: org.name },
          next: `Call setup_status, then set this workspace up with workspaceId: "${org.id}" on every business tool.`,
        })
      }),
  )
  server.registerTool(
    'forwarding_guide',
    {
      description:
        "How to forward a workspace's business line to its assistant's number: codes to dial (or settings to change) for the line's carrier or phone system, to turn forwarding on and off. Pass the business line's country (ISO 3166-1 alpha-2, e.g. \"US\", \"GB\"; default the workspace's country): the guides are that country's carriers and regional phone systems plus the international phone systems (RingCentral, Dialpad, 8x8, Teams Phone, 3CX …, listed in every country), and the number is written the way that country dials it. A country without carrier guides of its own gets the standard GSM codes and the phone's own settings (the answer's `countries` lists the countries with carrier guides). Needs a number in a forwarding mode in that workspace.",
      inputSchema: z.object({
        carrier: z
          .string()
          .trim()
          .min(2)
          .max(60)
          .describe('The business line\'s carrier or phone system, e.g. "Verizon", "RingCentral"'),
        country: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, 'a two-letter country code (ISO 3166-1 alpha-2), e.g. US or GB')
          .transform(c => c.toUpperCase())
          .optional()
          .describe('The country the business line is in (ISO 3166-1 alpha-2, e.g. "US", "CA", "GB"); default the workspace\'s country (workspace settings, else worked out from its numbers)'),
        mode: z.enum(['forward_conditional', 'forward_all']).default('forward_conditional'),
        workspaceId: workspaceIdField,
      }),
      annotations: read,
    },
    async ({ carrier, country: asked, mode, workspaceId }) =>
      guard('forwarding_guide', async () => {
        const inWs = await setupActorIn(actor, workspaceId)
        if (!inWs?.workspaceId) return refusal(NOT_YOUR_WORKSPACE)
        const [number] = await db
          .select({ e164: phone_numbers.e164 })
          .from(phone_numbers)
          .where(and(eq(phone_numbers.workspace_id, inWs.workspaceId), eq(phone_numbers.mode, mode)))
          .limit(1)
        if (!number) return refusal(`no number in mode ${mode} yet: phoneNumber_setup first`)
        // A country without guides of its own gets the "Other country" guides (standard GSM codes, phone settings).
        const requested = asked ?? (await workspaceLocale(db, inWs.workspaceId)).resolvedCountry
        const country = hasForwardingCountry(requested) ? requested : OTHER_COUNTRY
        const countries = forwardingCountries.map(c => c.code)
        // The country's carriers, or the "Other country" ones, and the phone systems sold in the country asked for.
        const guides = searchForwardingGuides(carrier, requested).slice(0, 3)
        const shown = guides.length ? guides : guidesForCountry(country).slice(0, country === OTHER_COUNTRY ? 2 : 0)
        if (!shown.length)
          return refusal(
            `no guide for "${carrier}" in ${requested}: ask for the carrier's name, or a mobile/landline/phone system. Countries with guides: ${countries.join(', ')}; any other country gets the standard codes.`,
          )
        // The best match decides: a carrier that forwards only within its country can't reach a number abroad.
        const warning = abroadWarning(number.e164, requested, shown[0])
        return answer({
          forward_to: number.e164,
          country: requested,
          ...(country === OTHER_COUNTRY
            ? {
                note: `No carrier guides for ${requested} yet: these are the standard GSM codes (the number written internationally), the phone's own settings and the international phone systems. Codes can differ by carrier.`,
              }
            : {}),
          ...(warning
            ? {
                warning:
                  warning.kind === 'blocked'
                    ? `${warning.text} Suggest a number in the business's country.`
                    : `The assistant's number is not in ${requested}: forwarding goes abroad and can cost extra or be blocked. Suggest a number in the business's country.`,
              }
            : {}),
          countries,
          guides: shown.map(guide => ({
            id: guide.id,
            name: guide.name,
            instructions: forwardingInstructions(guide, mode as ForwardingMode, number.e164, requested),
          })),
        })
      }),
  )
  server.registerTool(
    'setup_endAccess',
    {
      description:
        'End your access at the end of the setup: the setup link you are using stops working at once (only this one). Call it last, after your summary to the admin. setup_status.wrap_up says when; with steps still open, ask the admin first. Every later call with this link is refused. The admin can make a new link at any time.',
      inputSchema: z.object({}),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async () =>
      guard('setup_endAccess', async () => {
        const { body } = await runAction('agentSetup.endOwnAccess', {}, actor)
        if (!body.ok) return refusal(body.error)
        return answer({
          ok: true,
          ended: true,
          message:
            'Your access has ended: this setup link no longer works. The setup page tells the admin; they can make a new link at any time. Tell them in one line that you ended it.',
        })
      }),
  )
  for (const name of SETUP_ACTIONS) {
    const def = actions.get(name)
    if (def && (serverTools || !isServerAction(name))) registerAction(server, def, actor)
  }
}

/** The setup tools for this setup key's admin (or, for a workspace key, its owner). */
export function setupMcpServerFor(actor: Actor) {
  const instructions = actor.setupWorkspaceId ? SETUP_MCP_WORKSPACE_INSTRUCTIONS : SETUP_MCP_INSTRUCTIONS
  const server = new McpServer({ name: 'linedesk-setup', version: '1' }, { instructions })
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
  const access = await setupKeyAccess(key, clientIp)
  if (access.kind === 'limited') return refuse(429, 'rate limit: try again in a minute', { 'retry-after': '60' })
  // A key that existed and ended: why, never counted against the address (agent-setup.ts setupKeyAccess).
  if (access.kind === 'ended') return setupKeyEndedResponse(access.reason)
  if (access.kind === 'unknown' && blocked)
    return refuse(429, 'too many invalid setup keys from this address; try again later', { 'retry-after': '600' })
  if (access.kind === 'unknown')
    return refuse(
      401,
      'unknown, ended or expired setup key: make a new one in Linedesk (Set up with an agent)',
      challenge,
    )
  const { actor } = access
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
      authInfo: {
        token: 'setupkey',
        clientId: actor.actorId,
        scopes: [...actor.permissions],
        extra: { actor },
      },
    })
    const body = await res.text()
    release()
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch (e) {
    release()
    throw e
  }
}
