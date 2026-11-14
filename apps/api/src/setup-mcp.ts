// Setup MCP at /mcp/setup (LIN-125, docs/api.md "Setup MCP"): an AI agent (Claude, ChatGPT, Codex, Cursor, any MCP
// client, or curl) sets up the install for its instance admin. Authenticated with a setup key (agent-setup.ts), in the
// URL (/mcp/setup/<key>, for clients that cannot send headers: claude.ai, ChatGPT) or as Bearer. Stateless like /mcp.
//
// The tools: setup_status (what is done, the next step and how), providers_list, workspace_create, forwarding_guide,
// setup_endAccess (the agent ends its own link at the end, agentSetup.endOwnAccess), and the registry actions in SETUP_ACTIONS, run through runAction as the admin (same permissions and command log,
// marked as done with the setup key). Nothing else: no users, admins, other workspaces, API keys, impersonation or
// deleting. Every provider key can be set here (LIN-182: the admin never pastes a key into the app); provider_setKeys
// runs the free provider test right after saving and returns it, and answers with "set" and the last 4 of a secret,
// never the secret. Email and sign-in keep the passkey step-up (admin-step-up.ts): only a key the admin confirmed
// with a passkey changes them, and the refusal tells the agent to ask the admin in the chat. The workspace actions
// run without instance:admin, so buying numbers keeps the caps of number-purchases.ts.
import {
  type ActionDef,
  actions,
  agentSetupAllowHash,
  callAudioGuide,
  type ForwardingMode,
  forwardingInstructions,
  type GroupStatus,
  installPlace,
  isMultiCategory,
  LOCAL_INSTALL_NOTE,
  oneKey,
  type ProviderCategory,
  type ProviderName,
  providerCategories,
  providerGroupIds,
  providerGroups,
  providerSpec,
  recommendedProviders,
  restartCategories,
  SETUP_MCP_INSTRUCTIONS,
  searchForwardingGuides,
  statusText,
  type SetupStepGroup,
  setupStepNames,
} from '@linedesk/actions'
import {
  agent_setup_keys,
  assistants,
  calls,
  member,
  organization,
  phone_numbers,
  transcript_segments,
  user,
  workspace_settings,
} from '@linedesk/db'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { PASSKEY_STEP_UP_REQUIRED, passkeyStillNeeded, type StepUp } from './admin-step-up.ts'
import {
  clientName,
  emailAndSignInAllowed,
  noteAllowRequest,
  type RequestOrigin,
  setupKeyAccess,
  setupKeyEndedResponse,
  tooManyRefusedSetupKeys,
  webAddress,
} from './agent-setup.ts'
import { auth } from './auth.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { goLiveChecklist } from './go-live-checklist.ts'
import { readInstallProgress } from './install-setup.ts'
import { guard, MCP_MAX_BODY_BYTES, takeSlot, toolName } from './mcp.ts'
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
    "Ask the admin for the key in the chat and pass it here; never ask them to paste it into the app. The answer shows each field as set (secrets only by their last 4) and `test`: the free provider test run right after saving. Email and sign-in providers need the admin's passkey confirmation of this setup link (the refusal says what to ask).",
  'install.setProgress':
    'The install part is marked finished by setup_status once its groups work; use this to skip a part the admin does not want now (skip: "<step>").',
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
/**
 * Messages from provider tests and errors are written for the app ("Enter a valid key under Admin › Providers ›
 * Deepgram."). The agent stores keys itself, so they say what the agent does instead of sending the admin there.
 */
export function forAgent(text: string): string {
  return text
    .replace(
      /Enter a (valid key|new client secret) under Admin › Providers › [^."]+\./g,
      (_, what: string) => `Ask the admin for a ${what} and store it again with provider_setKeys.`,
    )
    .replace(/ under Admin › Providers › [^."]+\./g, ' with the admin, then store it again with provider_setKeys.')
    .replace(/[Cc]onnect (it|email) in Admin, Providers(, Email)?/g, 'set up email with provider_setKeys')
}
const answer = (data: Record<string, unknown>): ToolResult => {
  const text = forAgent(JSON.stringify(data))
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) }
}
const refusal = (error: string): ToolResult => ({ content: [{ type: 'text', text: forAgent(error) }], isError: true })

/** How often the agent reads setup_status while it waits for the admin's Allow. */
const ALLOW_POLL_SECONDS = 10

/** The setup page with Allow for this setup key only (agent-setup.ts confirmPasskey refuses any other key). */
const allowPage = (keyId: string | undefined) =>
  `${webAddress()}/${keyId ? agentSetupAllowHash(keyId) : '#setup-agent'}`

/**
 * After PASSKEY_NEEDED: how the agent learns that the admin allowed it, without retrying the refused tool blindly.
 * setup_status is read-only and says `email_and_sign_in_allowed` (setupStatus).
 */
const WAIT_FOR_ALLOW = `Then wait for them: do not call this tool again yet. Call setup_status { read_only: true } (changes nothing) every ${ALLOW_POLL_SECONDS} seconds or when the admin says they allowed it, until it answers email_and_sign_in_allowed: true (after 15 minutes, stop and ask the admin); then call this tool again with the same values. This setup link keeps working meanwhile.`

/**
 * Email and sign-in decide who can sign in, so changing them needs the admin's passkey (admin-step-up.ts), for an
 * agent too; so does recording storage on this server or a private network (s3-endpoint.ts). What the agent says in
 * the chat: never "paste it in the app", only the one thing a person must do, with the link that allows this key.
 */
export function passkeyNeeded(stepUp: StepUp | undefined, keyId?: string, reason?: string): string {
  const page = allowPage(keyId)
  const why =
    reason === 'private_endpoint'
      ? 'a storage endpoint on this server or a private network could reach internal services, so it needs'
      : 'email and sign-in decide who can sign in, so changing them needs'
  return stepUp === 'enrol'
    ? `PASSKEY_NEEDED: ${why} the admin's passkey, and they have none yet. Nothing was stored. Ask the admin in this chat to add one in the browser (you cannot add passkeys): ${addPasskeyHow()} Then ask them to open ${page} and click "Allow with passkey". ${WAIT_FOR_ALLOW} Or skip this for now and go on with the next step.`
    : `PASSKEY_NEEDED: ${why} the admin's passkey. This setup link does not have it. Nothing was stored. Ask the admin in this chat to open ${page}: a dialog names the setup link; they check it is the one you use, click "Allow with passkey" and confirm with their passkey (no keys to paste). ${WAIT_FOR_ALLOW}`
}

/**
 * How the admin adds their first passkey, said for the agent. The first admin, made with the setup code, has the
 * enrolment code filled in already in the browser they set up in (app.ts /v1/setup); anyone else needs one.
 */
function addPasskeyHow(): string {
  return `open ${webAddress()}/#account/security and click "Add passkey". If they made their account with the setup code from the server log, the enrolment code is filled in already in that browser; otherwise it needs one: if you can run commands on the server, run docker compose exec api node apps/api/src/user-passkeys.ts --enrol --email <their email> (or pnpm --filter @linedesk/api user:passkeys --enrol --email <their email>) and give them the code it prints, or another instance admin gives them one.`
}

/** Instance admin rights only for the provider and install actions; the business's own actions run as its owner would. */
const actorFor = (name: string, actor: Actor): Actor => {
  if (name.startsWith('provider.') || name.startsWith('install.')) return actor
  const { passkeyConfirmed: _, ...rest } = actor
  return { ...rest, permissions: actor.permissions.filter(p => p !== 'instance:admin') }
}

/** provider.setKeys through the agent: stored like in the app, then the free test, so the agent can react at once. */
async function saveAndTest(provider: ProviderName, actor: Actor, saved: Record<string, unknown>) {
  const { body } = await runAction('provider.test', { provider, free: true }, actor)
  const test = body.ok ? body.data : { ok: false, message: body.error }
  const restarts = restartCategories.includes(providerSpec(provider).category)
    ? 'Sign-in is read at start: the API restarts to apply this, a few seconds. Call setup_status again after that.'
    : null
  return answer({ ok: true, ...saved, test, ...(restarts ? { note: restarts } : {}) })
}

function registerAction(server: McpServer, def: ActionDef, actor: Actor, from: RequestOrigin) {
  const notes = [def.description, EXTRA[def.name], ASK_FIRST[def.name]].filter(Boolean)
  const caution = ASK_FIRST[def.name]
  server.registerTool(
    toolName(def.name),
    {
      description: notes.join(' '),
      inputSchema: def.input as never,
      annotations: { readOnlyHint: Boolean(def.readOnly), destructiveHint: Boolean(caution) },
    },
    ((input: unknown) =>
      guard(def.name, async () => {
        const as = actorFor(def.name, actor)
        const { body } = await runAction(def.name, input ?? {}, as)
        if (!body.ok) {
          const refused = body as { code?: string; stepUp?: StepUp; reason?: string }
          // What waits for the admin's Allow: shown in the dialog with when and from where (agent-setup.ts).
          if (refused.code === PASSKEY_STEP_UP_REQUIRED && actor.setupKeyId)
            await noteAllowRequest(actor.setupKeyId, def.name, input, from)
          return refusal(
            refused.code === PASSKEY_STEP_UP_REQUIRED
              ? passkeyNeeded(refused.stepUp, actor.setupKeyId, refused.reason)
              : body.error,
          )
        }
        const result = { rows: body.rows, ...(body.data ? { data: body.data } : {}) }
        if (def.name === 'provider.setKeys')
          return saveAndTest((input as { provider: ProviderName }).provider, as, result)
        return answer({ ok: true, ...result })
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
    // The setup page: "Allow" there lets this setup link change email and sign-in (the admin's passkey).
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

/** Whether the install's own part is done: its provider steps by id, whatever comes before them (the passkey). */
export const installPartDone = (steps: readonly Pick<Step, 'id' | 'state'>[]) =>
  steps.filter(s => INSTALL_GROUP_STEPS.includes(s.id)).every(s => s.state === 'done')

/**
 * First, on an install that asks admins for a passkey: the admin's own passkey. Email and sign-in need it, and an
 * agent can never add one, so the step is the admin's (admin_only) and carries its how-to until it is done; the
 * agent goes on with the next step meanwhile. Not listed when admins need no passkey (ADMIN_SECOND_FACTOR=off).
 */
async function passkeyStep(actor: Actor): Promise<StepBase[]> {
  if (!adminSecondFactorRequired()) return []
  const needed = await passkeyStillNeeded(actor.actorId)
  return [
    {
      id: 'passkey',
      label: 'Your passkey',
      state: needed ? 'admin_only' : 'done',
      detail: needed ? 'Not added yet: email and sign-in wait for it' : 'Added',
      how: [
        "Do this first. Email and sign-in decide who can sign in, so changing them needs the admin's passkey; agents cannot add passkeys.",
        `Ask the admin in this chat to add one in the browser: ${addPasskeyHow()}`,
        `Then ask them to open ${allowPage(actor.setupKeyId)} and click "Allow with passkey", so this setup link may change email and sign-in.`,
        'Meanwhile go on with the next step. If the admin wants to skip the passkey for now, that is fine: only email and sign-in wait for it.',
      ],
    },
  ]
}

/** What the agent reads first and after every step. */
async function setupStatus(actor: Actor, { advance = true }: { advance?: boolean } = {}) {
  const { groups } = await setupChecklist(db)
  const group = (id: GroupStatus['id']) => groups.find(g => g.id === id)!
  const emailAndSignIn = await linkMayChangeEmailAndSignIn(actor)
  const steps: Step[] = [
    ...inGroup('you', await passkeyStep(actor)),
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
        `Email decides who gets sign-in codes, so it needs the admin's passkey: ${emailAndSignInNote(actor, emailAndSignIn)}`,
        'Once the test passes: provider_tryOut { kind: "email" } sends a six-digit code to the admin\'s own address; ask them for it in the chat and call provider_confirmEmail { code }. That proves delivery end to end.',
      ]),
      groupStep(group('call-audio'), callAudioLines(), 'livekit'),
    ]),
    ...inGroup('business', await workspaceSteps(actor, advance)),
  ]
  // The install's own part is done: the setup by hand does not open on it later (bookkeeping, like onboarding_setStep).
  if (advance && installPartDone(steps) && !(await readInstallProgress()).finishedAt)
    await runAction('install.setProgress', { finished: true }, actor)
  const next = steps.find(s => s.state !== 'done' && s.state !== 'admin_only') ?? null
  const waiting = steps.filter(s => s.state === 'admin_only')
  return {
    you_act_as: await whoAmI(actor),
    install: whereItRuns(),
    // The next step's how-to, and those of the admin's own steps while open (the passkey, the test call).
    steps: steps.map(({ how, ...s }) => (s.id === next?.id || s.state === 'admin_only' ? { ...s, how } : s)),
    next_step: next ? next.id : null,
    all_done: !next,
    // How to finish, ending this setup link with setup_endAccess.
    wrap_up: wrapUp(!next, waiting),
    // Whether provider_setKeys may store email and sign-in keys with this link now: the admin's Allow with passkey.
    email_and_sign_in_allowed: emailAndSignIn,
    optional: optionalSteps(groups, emailAndSignInNote(actor, emailAndSignIn)),
    app_links: appLinks(),
  }
}

/**
 * How the agent finishes: a short summary, then setup_endAccess as its last call. With the test call still open, the
 * admin makes it on the setup page first; with other steps open, the agent asks before ending its access.
 */
export function wrapUp(agentDone: boolean, waiting: readonly Pick<Step, 'id'>[]): string {
  const end =
    'then call setup_endAccess as your last call: this setup link stops working at once, and the setup page tells the admin you ended it.'
  if (!agentDone)
    return `Not finished yet. If you stop before every step is done, ask the admin first whether to end your access; if they agree, give a short summary of what is set up and what is left, ${end}`
  const open = waiting.map(s => s.id)
  if (open.includes('test_call'))
    return `Your part is done. Ask the admin to make the test call now, right on the setup page (${webAddress()}/#setup-agent): the button on the Test call row calls the assistant with their microphone. Call setup_status { read_only: true } every ${ALLOW_POLL_SECONDS} seconds or when they say they are done, until test_call is done (or they want to skip it). Then give a short summary of what is set up and what is left for them, ${end}`
  if (open.length)
    return `Your part is done; only the admin can do what is still open (${open.join(', ')}). Give a short summary of what is set up and what is left for them, ask whether to end your access now, and if they agree, ${end}`
  return `Everything is set up. Give the admin a short summary of what is set up and what is left for them (other workspaces, the optional steps), ${end}`
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

/** Whether this setup link may change email and sign-in now (the admin's Allow lasts, or the passkey rule is off). */
async function linkMayChangeEmailAndSignIn(actor: Actor): Promise<boolean> {
  const [key] = actor.setupKeyId
    ? await db
        .select({ until: agent_setup_keys.passkey_confirmed_until })
        .from(agent_setup_keys)
        .where(eq(agent_setup_keys.id, actor.setupKeyId))
    : []
  return emailAndSignInAllowed(key?.until ?? null)
}

/** Whether this setup link may change email and sign-in now, said for the agent. */
function emailAndSignInNote(actor: Actor, allowed: boolean): string {
  return allowed
    ? 'this setup link has it, so provider_setKeys stores email and sign-in keys directly.'
    : `this setup link does not have it yet. Before asking for the key, ask the admin in this chat to open ${allowPage(actor.setupKeyId)}, click "Allow with passkey" and confirm with their passkey (no keys to paste there). Then call setup_status { read_only: true } every ${ALLOW_POLL_SECONDS} seconds until email_and_sign_in_allowed is true.`
}

/**
 * The groups a first call does not need (sign-in, calendar, recording, business lookup): their state and how to set
 * them up through these tools, offered once the needed steps are done. Calendars themselves are connected per business
 * by signing in to Google or Microsoft in the browser (Settings › Calendar), the one part an agent cannot do.
 */
function optionalSteps(groups: GroupStatus[], passkey: string) {
  const how: Record<string, string[]> = {
    'sign-in': [
      ...guideLines(recommendedProviders.sign_in),
      'The OAuth app needs the redirect URIs that providers_list gives per provider (redirect_uris).',
      `Sign-in needs the admin's passkey: ${passkey}`,
    ],
    calendar: [
      'The Google or Microsoft sign-in app also connects calendars (set it up as for sign-in, with the calendar scopes in its help).',
      `Sign-in apps need the admin's passkey: ${passkey}`,
      `Connecting a calendar to the business is a Google or Microsoft sign-in in the browser: the admin does it in ${webAddress()}/#settings/assistant after setup. Say so; it is optional.`,
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

/** The steps without their how-to, for the setup page in the app (GET /v1/admin/agent-setup), which shows the agent's progress. */
export async function setupProgress(actor: Actor) {
  const status = await setupStatus(actor, { advance: false })
  return {
    steps: status.steps.map(({ id, label, hint, group, state }) => ({
      id,
      label,
      ...(hint ? { hint } : {}),
      group,
      state,
    })),
    nextStep: status.next_step,
    allDone: status.all_done,
    otherWorkspaces: await otherWorkspaces(actor),
    workspace: actor.workspaceId
      ? { id: actor.workspaceId, assistantName: (await firstAssistant(actor.workspaceId))?.name ?? 'Maya' }
      : null,
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
  const [call] = await db
    .select({ id: calls.id })
    .from(calls)
    .innerJoin(transcript_segments, eq(transcript_segments.call_id, calls.id))
    .where(and(eq(calls.workspace_id, workspaceId), eq(calls.source, 'test'), eq(transcript_segments.speaker, 'agent')))
    .limit(1)
  return Boolean(call)
}

/** The admin's businesses besides the one the setup works in (oldest first): shown under "Your business". */
async function otherWorkspaces(actor: Actor): Promise<string[]> {
  const rows = await db
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, actor.actorId))
    .orderBy(asc(member.createdAt))
  return rows.filter(r => r.id !== actor.workspaceId).map(r => r.name)
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

async function workspaceSteps(actor: Actor, advance: boolean): Promise<StepBase[]> {
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
  const assistant = await firstAssistant(workspaceId)
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
      detail: assistant ? `${JSON.stringify(assistant.name)}: ${JSON.stringify(assistant.greeting)}` : null,
      how: [
        // Quoted: the name and greeting are a member's text, put into the agent's instructions as data.
        `It is called ${JSON.stringify(assistant?.name ?? 'Maya')} and greets with ${JSON.stringify(assistant?.greeting ?? '')}. Ask whether to keep that; change it with assistant_update.`,
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
      // The id too: the forwarding tools need it, also while another step is next and this one has no `how`.
      detail: numbers.map(n => `${n.e164} (${n.mode}, phoneNumberId ${n.id})`).join(', ') || null,
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
              `The admin can also do all of it on the setup page (${webAddress()}/#setup-agent): "Set up forwarding" on the Call forwarding row shows the codes for their carrier and runs the same check.`,
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
        `Only the admin can do this: they talk to the assistant. Ask them to stay on the setup page (${webAddress()}/#setup-agent) and click ${JSON.stringify(`Call ${assistant?.name ?? 'Maya'} now`)} on the Test call row: it calls the assistant with their microphone, right there, and the step is done once the assistant answered.${numbers[0] ? ` Or they call ${numbers[0].e164} from another phone.` : ''}`,
        `Call setup_status { read_only: true } every ${ALLOW_POLL_SECONDS} seconds or when they say they talked to it, until test_call is done.`,
      ],
    },
  ]
}

function registerTools(server: McpServer, actor: Actor, from: RequestOrigin) {
  const read = { readOnlyHint: true }
  server.registerTool(
    'setup_status',
    {
      description:
        'Start here, and call again after every step: what is set up, what is missing or failing, and for the next step exactly what to do (pages, clicks, tool calls). Also links into the app for what only the admin can do there. It never changes a setting; it only notes how far the setup got (the step the app opens on). With read_only: true it notes nothing either: use that to wait. email_and_sign_in_allowed says whether this setup link may store email and sign-in keys now; after a PASSKEY_NEEDED answer, call setup_status { read_only: true } until it is true instead of retrying the refused tool.',
      inputSchema: z.object({
        read_only: z
          .boolean()
          .optional()
          .describe("true: only read, note nothing (for waiting, e.g. for the admin's Allow with passkey)"),
      }),
      annotations: read,
    },
    async (input: { read_only?: boolean }) =>
      guard('setup_status', async () => answer(await setupStatus(actor, { advance: !input?.read_only }))),
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
              ...(spec.category === 'sign_in' ? { redirect_uris: redirectUris(p.provider) } : {}),
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
  server.registerTool(
    'setup_endAccess',
    {
      description:
        'End your access at the end of the setup: the setup link you are using stops working at once (only this one; with its permission for email and sign-in). Call it last, after your summary to the admin. setup_status.wrap_up says when; with steps still open, ask the admin first. Every later call with this link is refused. The admin can make a new link at any time.',
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
    if (def) registerAction(server, def, actor, from)
  }
}

/** The setup tools for this setup key's admin. */
export function setupMcpServerFor(actor: Actor, from: RequestOrigin = { ip: null, client: null }) {
  const server = new McpServer({ name: 'linedesk-setup', version: '1' }, { instructions: SETUP_MCP_INSTRUCTIONS })
  registerTools(server, actor, from)
  return server
}

const handler = createMcpHandler(
  ctx => setupMcpServerFor(ctx.authInfo!.extra!.actor as Actor, ctx.authInfo!.extra!.from as RequestOrigin),
  {
    responseMode: 'json',
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
    onerror: e => console.error(`setup mcp: ${e.message}`),
  },
)

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
        extra: { actor, from: { ip: clientIp, client: clientName(request.headers.get('user-agent')) } },
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
