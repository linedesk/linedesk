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
// impersonation or deleting. Every provider key but billing's can be set here (LIN-182: the admin never pastes a key into the app; the
// billing keys only in the app, billing-settings.ts); provider_setKeys
// runs the free provider test right after saving and returns it, and answers with "set" and the last 4 of a secret,
// never the secret. One access level: the key was made in a session that passed the admin's passkey check, so it sets
// email and sign-in too, with no second Allow step (decision of 2026-11-15). The workspace actions run without instance:admin, so buying numbers keeps the caps of number-purchases.ts.
//
// A workspace owner's key (agent_setup_keys.workspace_id, agent-setup.ts) gets only that workspace's part: setup_status
// with that one workspace and no server steps, the business tools, forwarding_guide and setup_endAccess. Never
// providers_list, workspace_create or a provider or install action (not even registered), and its own instructions
// (SETUP_MCP_WORKSPACE_INSTRUCTIONS), which ask for no provider keys.
//
// A white-label partner owner's key (agent_setup_keys.partner_id, 2026-11-18) gets the partner's own steps
// (setup_status.steps: company, brand, team, client workspaces) and its client workspaces' steps, the partner's own
// tools (PARTNER_KEY_PARTNER_ACTIONS, its partnerId filled in, never asked for) and the workspace tools of
// PARTNER_KEY_WORKSPACE_ACTIONS: never a number, a forwarding check, a lookup, a new client workspace (a seat on the
// bill) or the bill; those are the owner's rows on the partner's agent page. Its own instructions
// (SETUP_MCP_PARTNER_INSTRUCTIONS).
import {
  type ActionDef,
  abroadWarning,
  actions,
  BASE_BUY_OFFERS,
  type BuyOffer,
  buyingCountryOf,
  buyOfferIn,
  CHATGPT_PLUGINS_URL,
  CLAUDE_CONNECTORS_URL,
  CARRIER_LABELS,
  callAudioGuideIn,
  categoryNames,
  countryNamed,
  type DialCode,
  english,
  type ForwardingGuide,
  type ForwardingMode,
  forwardingCountries,
  forwardingInstructions,
  type GroupStatus,
  groupText,
  guidesForCountry,
  hasForwardingCountry,
  installParts,
  installPlace,
  isMultiCategory,
  LOCAL_INSTALL_NOTE,
  moneyCategories,
  NUMBER_LIST_PRICES,
  OTHER_COUNTRY,
  onboardingSteps,
  oneKey,
  oneKeyIn,
  type ProviderCategory,
  type ProviderName,
  providerCategoryLabel,
  providerGroupIds,
  providerGroups,
  providerGuide,
  providerHelp,
  providerSpec,
  REALTIME_VOICE_IDS,
  recommendedProviders,
  restartCategories,
  rolePermissions,
  SETUP_MCP_INSTRUCTIONS,
  SETUP_MCP_WORKSPACE_INSTRUCTIONS,
  SETUP_REPORT_SUMMARY_MAX,
  type SetupStepGroup,
  type SetupStepName,
  searchForwardingGuides,
  setupMcpPartnerInstructions,
  setupStepNames,
  setupStepNamesIn,
  statusText,
  UNPAID_PARTNER_CLIENTS,
  type Words,
  type WorkspaceCreateData,
} from '@linedesk/actions'
import {
  assistants,
  type BusinessProfile,
  billing_accounts,
  calls,
  commands,
  feedback,
  member,
  member_notification_settings,
  organization,
  phone_numbers,
  user,
  workspace_settings,
} from '@linedesk/db'
import { languageInSentence } from '@linedesk/i18n'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  type ManagedWorkspace,
  PARTNER_KEY_PARTNER_ACTIONS,
  PARTNER_KEY_WORKSPACE_ACTIONS,
  setupActorIn,
  setupKeyAccess,
  setupKeyEndedResponse,
  setupWorkspaces,
  tooManyRefusedSetupKeys,
  webAddress,
} from './agent-setup.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { localeForUserId } from './email-locale.ts'
import { goLiveChecklist } from './go-live-checklist.ts'
import { readInstallProgress } from './install-setup.ts'
import { workspaceBillFacts } from './billing-page.ts'
import { buildSetupReport, consentText, SENDING_OFF, type SetupReportInput } from './setup-feedback.ts'
import { withoutHopByHopHeaders } from './keep-alive.ts'
import { guard as mcpGuard, MCP_MAX_BODY_BYTES, takeSlot, toolName } from './mcp.ts'
import { numberBuyOffers } from './number-buy.ts'
import { newAssistant } from './onboarding.ts'
import { type PartnerSetupFacts, partnerPast, partnerSetupFacts } from './partner-setup.ts'
import { pipelinesSetUp, providerStatus } from './provider-settings.ts'
import { runAction } from './run-action.ts'
import { isPendingPayment, waitsForOwnTrial } from './self-serve.ts'
import { isPlaceholderWorkspaceName, servedCountriesOf } from './served-countries.ts'
import { GROUP_STATE, type StepState, setupChecklist } from './setup-checklist.ts'
import { assistantSpokeIn } from './setup-events.ts'
import { trialStartPath } from './trial-link.ts'
import { type CarrierAccount, telephonyForWorkspace } from './workspace-carrier.ts'
import {
  mayCreateWorkspace,
  SETUP_LINK_CAP_TEXT,
  SETUP_LINK_WORKSPACE_CAP,
  WORKSPACE_CREATION_CLOSED,
  workspacesMadeBy,
} from './workspace-creation.ts'
import { workspaceLocale } from './workspace-locale.ts'

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
  'phoneNumber.listCarrierNumbers',
  'phoneNumber.update',
  'phoneNumber.lookupLine',
  'phoneNumber.checkForwarding',
  'phoneNumber.forwardingCheck',
  'onboarding.setStep',
] as const

/**
 * Who the agent talks to, as its texts name them: the instance admin (an install link), or the workspace's owner or
 * admin (a workspace link). A workspace link's person is never sent to Server admin: the server is not theirs to set up.
 */
export const personOf = (actor: Pick<Actor, 'setupWorkspaceId' | 'setupWorkspaceRole' | 'setupPartnerId'>) =>
  actor.setupPartnerId
    ? 'partner owner'
    : !actor.setupWorkspaceId
      ? 'admin'
      : actor.setupWorkspaceRole === 'admin'
        ? 'workspace admin'
        : 'owner'

/** A link of someone who does not run the server (a workspace's or a partner's): no server texts, no providers. */
const notServerLink = (actor?: Pick<Actor, 'setupWorkspaceId' | 'setupPartnerId'>) =>
  Boolean(actor?.setupWorkspaceId || actor?.setupPartnerId)

/** The setup page this link's person works on: the partner's agent page, or the setup page. */
const setupPage = (actor: Pick<Actor, 'setupPartnerId'>) =>
  `${webAddress()}/${actor.setupPartnerId ? '#partner/agent' : '#setup-agent'}`

/**
 * Tools a client should confirm with the person first: they cost money or undo work. The provider tools are only on an
 * install link, so their person is always the instance admin.
 */

const askFirst = (actor: Actor): Record<string, string> => ({
  'phoneNumber.setup': english.t('server.setupAgent.mcp.buyAskFirst', { who: personOf(actor) }),
  'provider.clearKeys': 'Removes the stored keys of a provider: ask the admin first.',
  'provider.tryOut':
    'kind "email" sends one real email with a six-digit code to the admin\'s own address: ask them for the code, then provider_confirmEmail { code }. kind "telephony" lists numbers without buying any.',
})

/** What the agent is told about a tool on top of the registry's description (install links only). */
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
/** Who fixes the server's part, as a workspace link's texts say it (they never name Server admin). */
const SERVER_PART = '(that is for whoever runs this Linedesk server, not part of this workspace)'

/**
 * Messages from provider tests and errors are written for the app ("Enter a valid key under Server admin › Providers ›
 * Deepgram."). On an install link the agent stores keys itself, so they say what the agent does instead of sending the
 * admin there. On a workspace link (`workspaceLink`) the server is not the person's to set up and no provider tool is
 * there: the place in Server admin becomes who fixes it. Failures stored before the rename (provider_failures) still
 * say "Admin › Providers" or "Admin, Providers": both match.
 */
export function forAgent(text: string, workspaceLink = false): string {
  if (workspaceLink)
    return text
      .replace(/(?:under|in) (?:Server admin|Admin)(?:, | › )Providers(?:(?:, | › )[^.,"]+)?/g, SERVER_PART)
      .replace(
        /phone setup is not configured: LIVEKIT_SIP_ENDPOINT is not set/g,
        `numbers cannot be connected on this server yet: its voice server is not finished ${SERVER_PART}`,
      )
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
const answer = (data: Record<string, unknown>, actor?: Actor): ToolResult => {
  const text = forAgent(JSON.stringify(data), notServerLink(actor))
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

const refusal = (error: string, actor?: Actor): ToolResult => ({
  content: [{ type: 'text', text: forAgent(error, notServerLink(actor)) }],
  isError: true,
})

/**
 * What an unexpected failure says on an install link: "internal error" plus one line offering a setup report, so a
 * failure that keeps happening reaches the Linedesk team. Workspace and partner links have no setup reports.
 */
export const SETUP_INTERNAL_ERROR = english.t('server.setupAgent.report.internalError')
const guard = (actor: Actor, tool: string, work: () => Promise<ToolResult>) =>
  mcpGuard(tool, work, notServerLink(actor) ? undefined : SETUP_INTERNAL_ERROR)

/** How often the agent reads setup_status while it waits for the admin (the test call). */
const POLL_SECONDS = 10

/** The server's own actions (providers, the install's progress): instance admin rights, in no workspace. */
const isServerAction = (name: string) => name.startsWith('provider.') || name.startsWith('install.')

/** What a business tool says when its workspace is not one the person may set up (or does not exist). */
const notYourWorkspace = (actor: Actor) =>
  actor.setupPartnerId
    ? english.t('server.setupAgent.partner.notYourWorkspace')
    : actor.setupWorkspaceId
      ? 'That workspaceId is not one you can set up: this setup link is for one workspace only, use the id in setup_status.workspaces. Nothing was changed.'
      : 'That workspaceId is not one you can set up: use the id of one of setup_status.workspaces (workspaces where the admin is owner or admin). Nothing was changed.'

/**
 * notifications.update answers with the member's settings, push included: the server's push (VAPID) key and the
 * member's devices are the browser's business, never the agent's. Only whether push is on and how many devices.
 */
function forSetupAgent(name: string, data: unknown): unknown {
  if (name !== 'notifications.update' || !data || typeof data !== 'object') return data
  const { push, ...rest } = data as { push?: { summary?: unknown; devices?: unknown[] } }
  return push ? { ...rest, push: { summary: push.summary, devices: push.devices?.length ?? 0 } } : rest
}

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
  const caution = askFirst(actor)[def.name]
  const notes = [
    def.description,
    serverAction ? null : 'Pass workspaceId: the workspace (from setup_status.workspaces) this acts in.',
    EXTRA[def.name],
    caution,
  ].filter(Boolean)
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
      guard(actor, def.name, async () => {
        let as: Actor | null = actor
        let input = raw ?? {}
        if (!serverAction) {
          // The business's own actions run as its owner or admin would, never with instance admin rights or the
          // passkey confirmation, and only in a workspace the admin is owner or admin of.
          const { workspaceId, ...rest } = input as { workspaceId: string }
          as = await setupActorIn(actor, workspaceId)
          if (!as) return refusal(notYourWorkspace(actor), actor)
          input = rest
        }
        const { body } = await runAction(def.name, input, as)
        if (!body.ok) return refusal(body.error, actor)
        const result = { rows: body.rows, ...(body.data ? { data: forSetupAgent(def.name, body.data) } : {}) }
        if (def.name === 'provider.setKeys')
          return saveAndTest((input as { provider: ProviderName }).provider, as, result)
        return answer({ ok: true, ...result }, actor)
      })) as never,
  )
}

/** Links into the app for the steps only the admin can do there (a test call with their microphone, forwarding). */
const appLinks = (actor: Actor) => {
  const app = webAddress()
  // A partner owner's link: the partner's agent page and the partner area, nothing of Server admin.
  if (actor.setupPartnerId)
    return {
      app,
      agent_setup: setupPage(actor),
      partner_area: `${app}/#partner`,
      test_call: setupPage(actor),
    }
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
const inGroup = (group: SetupStepGroup, steps: StepBase[], names = setupStepNames): Step[] =>
  steps.map(({ id, alias, label, hint, ...rest }) => {
    const named = names[id]
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

/** Provider groups with billing keys: not offered here (billing-settings.ts, refuseMoneyKeysChange). The billing group also
 *  holds the sign-up bot check, which belongs with billing (an instance feature, off until turned on), so the whole group stays in the app. */
const moneyGroups = new Set<string>(
  providerGroups.filter(g => g.categories.some(c => moneyCategories.includes(c))).map(g => g.id),
)

/** How to set up one provider: its guide from the registry, written for an agent. */
const guideLines = (provider: ProviderName) => {
  const { label, category } = providerSpec(provider)
  const guide = providerGuide(provider)
  // After-call transcription is selected only by its own action (provider.setActive refuses it): optionalSteps says how.
  // Connected apps are all in use once set up: nothing to pick.
  const pick =
    category === 'transcript' || category === 'apps'
      ? ''
      : ` Then provider_setActive { category: "${category}", provider: "${provider}" } if another one is picked.`
  return [
    `${label} (provider "${provider}")${guide.url ? `, ${guide.url}` : ''}.`,
    // The guides are written for the app ("Paste it here"); an agent asks for the key instead.
    ...guide.steps.map(line => line.replace(/^Paste (it|both|them) here/, 'Ask the admin to paste $1 to you')),
    `Cost: ${guide.cost}`,
    `Store with provider_setKeys { provider: "${provider}", values: { <field>: <value> } } (fields: providers_list); it runs the free test right away and returns it as \`test\`.${pick}`,
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
  ...callAudioGuideIn().steps,
  `Cost: ${callAudioGuideIn().cost}`,
  'If you cannot run commands on the server, tell the admin these steps.',
]

/** The install's own steps (provider groups a first call needs); when all are done, the setup by hand is finished. */
const INSTALL_GROUP_STEPS: readonly string[] = installParts

/** Whether the install's own part is done: its provider steps by id. */
export const installPartDone = (steps: readonly Pick<Step, 'id' | 'state'>[]) =>
  steps.filter(s => INSTALL_GROUP_STEPS.includes(s.id)).every(s => s.state === 'done')

/** One workspace's steps for the agent, with its id: every business tool takes it as workspaceId. */
/**
 * What Linedesk already knows about a workspace's business, so the agent confirms it instead of asking (its first
 * reply: "I'll set up Linedesk for <name> (<what it does>, <city>). Is that right?"). Business text is data.
 */
type KnownBusiness = {
  name: string | null
  description: string | null
  address: string | null
  service_area: string | null
  website: string | null
  services: string[]
  hours: string | null
  /** The About text the assistant answers from (business_profile.instructions); when set, it replaces the fields. */
  about: string | null
  country: string
  language: string
  time_zone: string | null
}
type WorkspaceStatus = {
  id: string | null
  name: string | null
  role?: ManagedWorkspace['role']
  known?: KnownBusiness
  steps: Step[]
}

/**
 * The first step still to do (not done, not the admin's own), or the owner's Start your free trial (or plan) row while it
 * waits: nothing after it opens before it, as in the app (onboarding.setStep and a number are refused until then), so
 * the next step is that row, not the phone number.
 */
const firstOpen = (steps: readonly Step[]) =>
  steps.find(s => s.state !== 'done' && (s.state !== 'admin_only' || s.id === 'activate')) ?? null

/** What the agent reads first and after every step. */
async function setupStatus(actor: Actor, { advance = true }: { advance?: boolean } = {}) {
  const { groups } = await setupChecklist(db)
  const group = (id: GroupStatus['id']) => groups.find(g => g.id === id)!
  // A workspace owner's link: that workspace's part only.
  if (actor.setupWorkspaceId) return workspaceSetupStatus(actor, groups, advance)
  // A partner owner's link: the partner's own steps, then its client workspaces'.
  if (actor.setupPartnerId) return partnerSetupStatus(actor, groups, advance)
  // Once per server: the providers a first call needs. The admin's passkey is no step: making the setup link needed it.
  const steps: Step[] = [
    ...inGroup('server', [
      groupStep(group('email'), [
        ...guideLines(recommendedProviders.email),
        'Ask for the From address too (an address on the domain verified with the mail service) and store it with the key: values { api_key, from }.',
        'Once the test passes: provider_tryOut { kind: "email" } sends a six-digit code to the admin\'s own address; ask them for it in the chat and call provider_confirmEmail { code }. That proves delivery end to end.',
      ]),
      groupStep(
        group('answering'),
        [
          'Two ways; ask the admin which they prefer.',
          `Simplest, one account: OpenAI (${oneKey.url}). ${oneKeyIn().steps.slice(0, 2).join(' ')} Ask the admin to paste the key to you, then provider_connectOneKey { apiKey }. ${oneKeyIn().cost} ${oneKeyIn().caveat}`,
          'Best voice and every feature, three accounts (speech to text, language model, voice):',
          ...guideLines(recommendedProviders.stt),
          ...guideLines(recommendedProviders.llm),
          ...guideLines(recommendedProviders.tts),
        ],
        'ai',
      ),
      groupStep(group('telephony'), [...guideLines(recommendedProviders.telephony), ...devNumberLine()]),
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
    // Whether the admin was asked for a setup report to the Linedesk team yet (feedback_send), and when to ask.
    feedback: await setupFeedbackStatus(actor, !next),
    optional: optionalSteps(groups),
    app_links: appLinks(actor),
  }
}

/**
 * setup_status.feedback on an install link: no report for this link yet, how to offer one (at the end, ask now); once
 * one was sent or kept, that it exists, so the agent stops asking.
 */
async function setupFeedbackStatus(actor: Actor, allDone: boolean) {
  const [last] = actor.setupKeyId
    ? await db
        .select({ status: feedback.status })
        .from(feedback)
        .where(and(eq(feedback.setup_key_id, actor.setupKeyId), isNotNull(feedback.report)))
        .orderBy(desc(feedback.created_at))
        .limit(1)
    : []
  if (last)
    return {
      asked: true,
      status: last.status,
      how: english.t(
        last.status === 'sent' ? 'server.setupAgent.report.statusSent' : 'server.setupAgent.report.statusKept',
      ),
    }
  return {
    asked: false,
    how: english.t(allDone ? 'server.setupAgent.report.askNow' : 'server.setupAgent.report.askLater'),
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
    wrap_up: wrapUp(!next, waiting, { oneWorkspace: true, person: personOf(actor) }),
    app_links: appLinks(actor),
  }
}

/**
 * setup_status for a white-label partner owner's link: the partner's own steps (company, brand, team, client
 * workspaces), then each client workspace's own, as an install link has the server's and then its workspaces'.
 */
async function partnerSetupStatus(actor: Actor, groups: readonly GroupStatus[], advance: boolean) {
  const facts = await partnerSetupFacts(actor.setupPartnerId!)
  const steps = facts ? inGroup('partner', partnerSteps(actor, facts)) : []
  const workspaces = await workspaceStatuses(actor, advance)
  const partnerNext = firstOpen(steps)
  const nextWorkspace = partnerNext ? null : (workspaces.find(w => firstOpen(w.steps)) ?? null)
  const next = partnerNext ?? (nextWorkspace ? firstOpen(nextWorkspace.steps) : null)
  const waiting = [...steps, ...workspaces.flatMap(w => w.steps)].filter(s => s.state === 'admin_only')
  const shown = (list: Step[], here: boolean) =>
    list.map(({ how, ...s }) => ((here && s.id === next?.id) || s.state === 'admin_only' ? { ...s, how } : s))
  return {
    you_act_as: await whoAmI(actor),
    server_ready: serverReady(groups),
    // The partner's own part; its name is the partner's own text, as data.
    partner: facts ? { id: facts.id, name: facts.name, status: facts.status } : null,
    steps: shown(steps, Boolean(partnerNext)),
    // Each client workspace's own steps; pass its id as workspaceId to every business tool for it.
    workspaces: workspaces.map(w => ({
      ...w,
      steps: shown(w.steps, w === nextWorkspace),
      all_done: !firstOpen(w.steps),
    })),
    next_step: next ? next.id : null,
    next_workspace_id: nextWorkspace?.id ?? null,
    all_done: !next,
    wrap_up: wrapUp(!next, waiting, { person: personOf(actor), page: setupPage(actor) }),
    app_links: appLinks(actor),
  }
}

/** The price of one more client workspace, as the agent says it ("$11 a month"); none where billing is off. */
const seatText = (seat: PartnerSetupFacts['seat']) =>
  seat
    ? english.t(
        seat.interval === 'year' ? 'server.setupAgent.partner.seatYearly' : 'server.setupAgent.partner.seatMonthly',
        { price: `$${(seat.cents / 100).toFixed(seat.cents % 100 ? 2 : 0)}` },
      )
    : english.t('server.setupAgent.partner.seatNone')

/** The same price, short, as the Client workspaces row's hint on the setup page ("$9 a month each, billed yearly"). */
const seatHint = (seat: NonNullable<PartnerSetupFacts['seat']>, words: Words = english) =>
  words.t(
    seat.interval === 'year'
      ? 'server.setupAgent.partner.step.clientsPriceYearly'
      : 'server.setupAgent.partner.step.clientsPriceMonthly',
    { price: `$${(seat.cents / 100).toFixed(seat.cents % 100 ? 2 : 0)}` },
  )

/** A price in whole dollars where it has no cents ("$14", "$9.50"). */
const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`

/** What White-label Cloud costs, as its row's hint ("$14 a month, billed yearly, plus $9 per client workspace"). */
const planHint = (
  plan: NonNullable<PartnerSetupFacts['plan']>,
  seat: PartnerSetupFacts['seat'],
  words: Words = english,
) =>
  words.t(
    plan.interval === 'year'
      ? 'server.setupAgent.partner.step.planPriceYearly'
      : 'server.setupAgent.partner.step.planPriceMonthly',
    { price: dollars(plan.cents), seat: dollars(seat?.cents ?? 0) },
  )

/**
 * The partner's own steps' names in a reader's language: the agent's setup_status in English, the setup page in the
 * owner's (setupProgress). The Client workspaces row's hint says what one costs, White-label Cloud's its price.
 */
function partnerStepNamesIn(words: Words, facts: PartnerSetupFacts): Readonly<Record<string, SetupStepName>> {
  const named = (id: 'company' | 'brand' | 'team' | 'clients') => ({
    // i18n-dynamic: server.setupAgent.partner.step.*
    label: words.t(`server.setupAgent.partner.step.${id}`),
    hint: words.t(`server.setupAgent.partner.step.${id}Hint`),
  })
  return {
    company: named('company'),
    brand: named('brand'),
    team: named('team'),
    clients: { ...named('clients'), ...(facts.seat ? { hint: seatHint(facts.seat, words) } : {}) },
    ...(facts.plan
      ? {
          plan: {
            label: words.t('server.setupAgent.partner.step.plan'),
            hint: planHint(facts.plan, facts.seat, words),
          },
        }
      : {}),
  }
}

/**
 * The partner's own steps. Its company name and brand are the partner's own text, quoted as data. The client
 * workspaces row is the owner's own (a seat on the bill), done once there is one; more can follow from the same row.
 * Where billing is on, the last row is White-label Cloud itself: the owner activates it (its Checkout, charged at once,
 * no trial) once the setup is ready. Before that up to UNPAID_PARTNER_CLIENTS client workspaces are drafts, and no
 * invitation, number or call goes out (setup before payment, 2026-11-18).
 */
function partnerSteps(actor: Actor, facts: PartnerSetupFacts): StepBase[] {
  const who = personOf(actor)
  const at = facts.step
  const unpaid = facts.plan?.unpaid ?? false
  const names = partnerStepNamesIn(english, facts)
  const named = (id: 'company' | 'brand' | 'team' | 'clients') => names[id]!
  const step = (id: 'company' | 'brand' | 'team', done: boolean, how: string[]): StepBase => ({
    id,
    ...named(id),
    state: done ? 'done' : 'todo',
    how,
  })
  return [
    // The company's name is given at sign-up: done once there is one, as every step follows the data.
    step('company', facts.name.trim() !== '' || partnerPast(at, 'company'), [
      english.t('server.setupAgent.partner.companyHow', { name: JSON.stringify(facts.name), who }),
    ]),
    {
      ...step('brand', facts.brandSaved || partnerPast(at, 'brand'), [
        english.t('server.setupAgent.partner.brandHow', { who }),
        english.t('server.setupAgent.partner.brandReview', { who }),
      ]),
      detail: facts.brandName ? JSON.stringify(facts.brandName) : null,
    },
    step('team', facts.team > 0 || partnerPast(at, 'team'), [
      english.t(unpaid ? 'server.setupAgent.partner.teamHowUnpaid' : 'server.setupAgent.partner.teamHow', { who }),
    ]),
    {
      id: 'clients',
      // With what one costs, where the page shows it next to "Add client" (the owner confirms the seat there).
      ...named('clients'),
      state: facts.clients.length ? 'done' : 'admin_only',
      detail: facts.clients.map(c => JSON.stringify(c.name)).join(', ') || null,
      how: [
        english.t('server.setupAgent.partner.clientsHow', {
          who,
          price: seatText(facts.seat),
          page: setupPage(actor),
          seconds: POLL_SECONDS,
        }),
        ...(unpaid
          ? [english.t('server.setupAgent.partner.clientsHowUnpaid', { who, limit: UNPAID_PARTNER_CLIENTS })]
          : []),
      ],
    },
    ...(facts.plan
      ? [
          {
            id: 'plan',
            ...names.plan!,
            // The owner's own row: its button opens the Checkout. Done once paid.
            state: unpaid ? 'admin_only' : 'done',
            how: [
              english.t('server.setupAgent.partner.planHow', {
                who,
                page: setupPage(actor),
                seconds: POLL_SECONDS,
              }),
            ],
          } satisfies StepBase,
        ]
      : []),
  ]
}

/** The steps of every workspace the admin may set up; without one yet, the way to the first (workspace_create). */
async function workspaceStatuses(actor: Actor, advance: boolean): Promise<WorkspaceStatus[]> {
  const mine = await setupWorkspaces(actor)
  // A workspace key whose owner lost the workspace meanwhile: nothing to set up (the next request is refused). A partner
  // key before its first client workspace: the partner's Client workspaces row is the way to one.
  if (!mine.length && (actor.setupWorkspaceId || actor.setupPartnerId)) return []
  if (!mine.length) return [{ id: null, name: null, steps: inGroup('business', noWorkspaceSteps()) }]
  const out: WorkspaceStatus[] = []
  for (const ws of mine) out.push(await workspaceStatus(actor, ws, advance))
  return out
}

async function workspaceStatus(actor: Actor, ws: ManagedWorkspace, advance: boolean): Promise<WorkspaceStatus> {
  const inWs = await setupActorIn(actor, ws.id)
  const steps = inWs ? await workspaceSteps(inWs, advance) : []
  // A partner (its key, or one of its team in the client workspace) sets up a client's: the steps speak about the client.
  const names = actor.setupPartnerId || (await viaPartner(actor.actorId, ws.id)) ? clientSetupStepNames : setupStepNames
  return {
    id: ws.id,
    name: ws.name,
    role: ws.role,
    known: await knownBusiness(ws),
    steps: inGroup('business', steps, names),
  }
}

/** What the workspace's profile and settings already say about the business (KnownBusiness). */
async function knownBusiness(ws: ManagedWorkspace): Promise<KnownBusiness> {
  const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
  const assistant = await firstAssistant(ws.id)
  const locale = await workspaceLocale(db, ws.id, settings ?? null)
  const profile = (assistant?.business_profile ?? {}) as BusinessProfile
  return {
    name: isPlaceholderWorkspaceName(ws.name) ? null : ws.name,
    description: profile.description || null,
    address: profile.address || null,
    service_area: profile.service_area || null,
    website: profile.website || null,
    services: profile.services ?? [],
    hours: profile.hours || null,
    about: profile.instructions?.trim() || null,
    country: locale.resolvedCountry,
    language: languageInSentence(locale.resolvedLanguage, 'en'),
    time_zone: settings?.timezone ?? null,
  }
}

/**
 * The workspace steps when a partner (owner or partner admin) sets up a CLIENT workspace (decision of 2026-11-18): they speak
 * about the client, not "your …". The client's own owner keeps setupStepNames.
 */
function clientStepNamesIn(words: Words): Readonly<Record<string, SetupStepName>> {
  const names = setupStepNamesIn(words)
  return {
    ...names,
    business: { ...names.business!, label: words.t('server.setupAgent.clientStep.business') },
    assistant: { ...names.assistant!, label: words.t('server.setupAgent.clientStep.assistant') },
    pickup: { ...names.pickup!, hint: words.t('server.setupAgent.clientStep.pickupHint') },
    phone: { ...names.phone!, hint: words.t('server.setupAgent.clientStep.phoneHint') },
    forwarding: { ...names.forwarding!, hint: words.t('server.setupAgent.clientStep.forwardingHint') },
  }
}
const clientSetupStepNames = clientStepNamesIn(english)

/** Whether `userId` is in `workspaceId` through a partner's team (/v1/me's workspace.viaPartner), not as its own. */
async function viaPartner(userId: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ partnerId: member.partnerId })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, workspaceId)))
  return Boolean(row?.partnerId)
}

/**
 * How the agent finishes: a short summary, then setup_endAccess as its last call. With a test call still open, the
 * admin makes it on the setup page first; with other steps open, the agent asks before ending its access.
 */
export function wrapUp(
  agentDone: boolean,
  waiting: readonly Pick<Step, 'id'>[],
  {
    oneWorkspace = false,
    person = 'admin',
    page = `${webAddress()}/#setup-agent`,
  }: { oneWorkspace?: boolean; person?: string; page?: string } = {},
): string {
  const end = `then call setup_endAccess as your last call: this setup link stops working at once, and the setup page tells the ${person} you ended it.`
  if (!agentDone)
    return `Not finished yet. If you stop before every step is done, ask the ${person} first whether to end your access; if they agree, give a short summary of what is set up and what is left, ${end}`
  const open = [...new Set(waiting.map(s => s.id))]
  if (open.includes('test_call') && oneWorkspace)
    return `Your part is done. Ask the ${person} to make the test call now, right on the setup page (${page}): the button on its Test call row calls the assistant with their microphone. Call setup_status { read_only: true } every ${POLL_SECONDS} seconds or when they say they are done, until test_call is done (or they want to skip it). Then give a short summary of what is set up and what is left for them, ${end}`
  if (open.includes('test_call'))
    return `Your part is done. Ask the ${person} to make the test call now, right on the setup page (${page}): they pick the workspace in the dropdown above its steps, and the button on its Test call row calls that workspace's assistant with their microphone (once per workspace whose test_call is open). Call setup_status { read_only: true } every ${POLL_SECONDS} seconds or when they say they are done, until test_call is done (or they want to skip it). Then give a short summary of what is set up and what is left for them, ${end}`
  if (open.length)
    return `Your part is done; only the ${person} can do what is still open (${open.join(', ')}). Give a short summary of what is set up and what is left for them, ask whether to end your access now, and if they agree, ${end}`
  return oneWorkspace
    ? `Everything is set up. Give the ${person} a short summary of what is set up and what is left for them, ${end}`
    : `Everything is set up. Give the admin a short summary of what is set up in each workspace and what is left for them (the optional steps), ${end}`
}

/** Where an OAuth app sends people back to: the same list as the provider's dialog (web ProviderLogo.tsx). */
function redirectUris(provider: ProviderName): string[] {
  const app = webAddress()
  if (provider === 'google') return [`${app}/api/auth/callback/google`, `${app}/v1/calendar/callback/google`]
  if (provider === 'microsoft')
    return [
      `${app}/api/auth/callback/microsoft`,
      `${app}/v1/calendar/callback/microsoft`,
      `${app}/v1/mail/callback/microsoft`,
    ]
  if (provider === 'google_mail') return [`${app}/v1/mail/callback/google`]
  if (provider === 'github') return [`${app}/api/auth/callback/github`]
  if (provider === 'oidc') return [`${app}/api/auth/oauth2/callback/oidc`]
  if (provider === 'calendly' || provider === 'calcom') return [`${app}/v1/calendar/callback/${provider}`]
  if (provider === 'hubspot' || provider === 'slack' || provider === 'jobber')
    return [`${app}/v1/apps/callback/${provider}`]
  return []
}

/**
 * The groups a first call does not need (sign-in, calendar, connected apps, recording, after-call transcription, business
 * lookup; not billing):
 * their state and how to set them up through these tools, offered once the needed steps are done. Calendars themselves
 * are connected per business by signing in to Google or Microsoft in the browser (Assistant settings › Booking &
 * calendar), the one part an agent cannot do. After-call transcription is turned on by the admin in the app (Server
 * admin › Providers › After-call transcription), because recordings leave the server; its key goes through these tools.
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
    // Selecting a provider uploads every call's recording to it: the admin turns it on in the app, never pasting a key.
    transcript: [
      "Off until the admin selects a provider: then each call's recording file is uploaded to it after the call and the caller's lines of the transcript are corrected. It needs recording. Ask the admin whether they want it; it is optional.",
      ...guideLines(recommendedProviders.transcript),
      `Turning it on is the admin's choice in ${webAddress()}/#admin/providers/transcript (app_links.providers_transcript), because recordings leave the server: there they only select the provider, with a key you stored or the key already saved for the same service (ElevenLabs: voice or speech to text; OpenAI: realtime model, speech to text or language model). Say so.`,
    ],
    business: guideLines(recommendedProviders.business),
    // White-label partners' own addresses (Partner › Domain): off until this provider is set up.
    domains: [english.t('server.setupAgent.optional.domains'), ...guideLines(recommendedProviders.domains)],
    apps: [
      ...guideLines(recommendedProviders.apps),
      'The OAuth app needs the redirect URI that providers_list gives (redirect_uris).',
      `Each business then connects its own account in the browser under ${webAddress()}/#integrations (a consent page, the one part an agent cannot do). Say so; it is optional.`,
    ],
  }
  return (
    providerGroups
      // Billing keys decide where money goes: only an instance admin in the app sets them (billing-settings.ts).
      .filter(g => !g.needed && !moneyGroups.has(g.id))
      .map(spec => {
        const group = groups.find(g => g.id === spec.id)
        const state = group ? GROUP_STATE[group.state] : 'todo'
        return {
          id: spec.id,
          ...groupText(spec.id),
          state: group?.state === 'off' ? 'off' : state,
          ...(group?.state === 'works' ? {} : { how: how[spec.id] ?? [] }),
        }
      })
  )
}

/** Where the install runs: on a computer or a private network, carriers cannot reach it (LOCAL_INSTALL_NOTE). */
function whereItRuns() {
  const address = webAddress()
  const place = installPlace(address)
  return place === 'public' ? { address, public: true } : { address, public: false, place, note: LOCAL_INSTALL_NOTE }
}

/**
 * A Cloud sign-up's own trial or plan that started (its Checkout confirmed): `trial` when it got
 * the free trial. Null for every other workspace (self-hosted, a partner's client, one an instance admin made).
 */
async function ownStartOf(workspaceId: string): Promise<{ trial: boolean } | null> {
  const [row] = await db
    .select({
      partnerId: organization.partnerId,
      state: organization.billingState,
      kind: billing_accounts.kind,
      confirmedAt: billing_accounts.checkout_confirmed_at,
      trialEndsAt: billing_accounts.trial_ends_at,
      refused: billing_accounts.trial_refused,
    })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspaceId))
  if (!row || row.partnerId || row.kind !== 'cloud' || row.state === 'pending_payment' || !row.confirmedAt) return null
  return { trial: row.trialEndsAt !== null && row.refused === null }
}

/**
 * The steps as the setup page names them, in the reader's language (`words`): setup_status names them in English for the
 * agent. The same names in the same places: a partner's own steps, a client workspace's steps about the client, the
 * install's and a business's own; a step without a name of its own keeps its label.
 */
async function pageStepNames(actor: Actor, workspaceId: string | null, steps: Step[], words: Words): Promise<Step[]> {
  if (words === english) return steps
  const client = Boolean(actor.setupPartnerId || (workspaceId ? await viaPartner(actor.actorId, workspaceId) : false))
  const facts = actor.setupPartnerId ? await partnerSetupFacts(actor.setupPartnerId) : null
  const business = client ? clientStepNamesIn(words) : setupStepNamesIn(words)
  const partner = facts ? partnerStepNamesIn(words, facts) : {}
  const startPlan = english.t('onboarding.steps.activatePlan')
  return steps.map(step => {
    // The trial's row: "Start your free trial", or "Start your plan" without a trial.
    if (step.id === 'activate')
      return {
        ...step,
        label: words.t(step.label === startPlan ? 'onboarding.steps.activatePlan' : 'onboarding.steps.activate'),
      }
    const name = step.group === 'partner' ? partner[step.id] : business[step.id]
    if (!name) return step
    const { hint: _hint, ...rest } = step
    return { ...rest, label: name.label, ...(name.hint ? { hint: name.hint } : {}) }
  })
}

/**
 * The steps without their how-to, for the setup page in the app (GET /v1/admin/agent-setup, and for a workspace
 * owner GET /v1/workspace/agent-setup: their one workspace's steps only), which shows the agent's
 * progress: the server's steps, then those of one workspace, `selected` when the admin may set it up, else their
 * first. `workspaces` lists every one they may set up, with how far each got (the page's dropdown).
 */
export async function setupProgress(actor: Actor, selected?: string | null, words: Words = english) {
  const status = await setupStatus(actor, { advance: false })
  // A workspace owner's page always has its one workspace (the route checks the owner); none only if it just went.
  const chosen: WorkspaceStatus = status.workspaces.find(w => w.id && w.id === selected) ??
    status.workspaces[0] ?? { id: null, name: null, steps: [] }
  const steps = [...status.steps, ...chosen.steps]
  const next = firstOpen(steps)
  const assistant = chosen.id ? await firstAssistant(chosen.id) : null
  return {
    steps: (await pageStepNames(actor, chosen.id, steps, words)).map(({ id, label, hint, group, state }) => ({
      id,
      label,
      ...(hint ? { hint } : {}),
      group,
      state,
    })),
    nextStep: next?.id ?? null,
    // A partner with no client workspace yet is not set up, though adding one is the owner's row (admin_only).
    allDone: !next && !steps.some(s => s.id === 'clients' && s.state !== 'done'),
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
    workspace: chosen.id
      ? {
          id: chosen.id,
          name: chosen.name ?? '',
          // Made by sign-up and not named yet: the page says so in place of the placeholder name.
          unnamed: isPlaceholderWorkspaceName(chosen.name ?? ''),
          assistantName: assistant?.name ?? 'Maya',
        }
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
    // The language they use the app in: the agent talks to them in it (SETUP_MCP_INSTRUCTIONS, "Talking to the person").
    language: languageInSentence(await localeForUserId(db, actor.actorId), 'en'),
    role: actor.setupPartnerId
      ? 'partner owner'
      : actor.setupWorkspaceId
        ? `workspace ${actor.setupWorkspaceRole ?? 'admin'}`
        : 'instance admin',
  }
}

/**
 * Whether onboarding has gone past `step` (the web app and onboarding_setStep move it). "Finish later" (`skipped`) is
 * past nothing: the owner left onboarding without setting anything up, so what is done follows the data alone.
 */
export const past = (current: string | null | undefined, step: (typeof onboardingSteps)[number]) =>
  current === 'done' ||
  onboardingSteps.indexOf(current as (typeof onboardingSteps)[number]) > onboardingSteps.indexOf(step)

/**
 * How far onboarding got, for `past`: the stored step, and after "Finish later" (`skipped`) the furthest step it was
 * moved to before (onboarding.setStep, in the command log), so a step passed with its defaults kept (Who hears about
 * calls saves nothing then) stays done after Finish later. The log keeps a command's input for 90 days (command-log.ts);
 * a workspace set aside longer counts by its data alone.
 */
export async function stepReached(workspaceId: string, step: string | null | undefined) {
  if (step !== 'skipped') return step
  const moves = await db
    .select({ input: commands.input })
    .from(commands)
    .where(
      and(
        eq(commands.workspace_id, workspaceId),
        eq(commands.action, 'onboarding.setStep'),
        eq(commands.rejected, false),
      ),
    )
  let furthest: string | null = null
  for (const { input } of moves) {
    const moved = (input as { step?: unknown } | null)?.step
    const at = onboardingSteps.indexOf(moved as (typeof onboardingSteps)[number])
    if (at > onboardingSteps.indexOf(furthest as (typeof onboardingSteps)[number])) furthest = moved as string
  }
  return furthest
}

/** With the realtime model the assistant picks one of the model's voices (`realtime_voice`); '' is marin, the default. */
const REALTIME_VOICE_NOTE = `Voice: one of the realtime model's voices, per assistant (assistant_update realtime_voice: ${REALTIME_VOICE_IDS.join(', ')}; empty for marin, the default)`
const assistantStepLabel = (realtime: boolean) =>
  realtime ? 'The assistant: name and greeting' : 'The assistant: name, greeting, voice'

/** The default assistant's name (assistants.name). */
const DEFAULT_ASSISTANT_NAME = 'Maya'
/** The transfer contact the notify step of onboarding saves (URGENT_CONTACT_ID, apps/web/src/onboarding/flow.ts). */
const URGENT_CONTACT_ID = 'urgent'

const BUSINESS_STEPS = [
  ['business', 'The business: its name, time zone, and what the assistant knows about it'],
  ['assistant', 'The assistant: name, greeting, voice'],
  ['pickup', 'When the assistant picks up'],
  ['notify', 'Call alerts: an email after every call, urgent calls to a mobile'],
  ['phone', 'Phone number: the number callers reach the assistant on'],
] as const

/**
 * Before the admin has a workspace: how to make the first, and what follows, so they see the whole way from the start.
 * The business is one step (its name and time zone, then what the assistant knows about it).
 */
const noWorkspaceSteps = (): StepBase[] => [
  {
    id: 'business',
    label: BUSINESS_STEPS[0][1],
    state: 'todo',
    how: [
      "Ask for the business's name (and check its time zone). Ask once whether they run more than one business or location: each gets its own workspace.",
      'workspace_create { name, timeZone } makes it, with its assistant, and returns its id; the rest of this step (what the assistant knows about the business) and the other business steps follow in setup_status.workspaces.',
    ],
  },
  ...BUSINESS_STEPS.slice(1).map(([id, label]) => ({ id, label, state: 'todo' as const })),
]

/** One workspace's steps; `actor` acts in it as its owner or admin (setupActorIn). */
/**
 * Learning from the business's emails (decision of 2026-11-19): right after the business is confirmed the agent offers to
 * read the customer requests in the person's own mailbox (a mail connector in their AI app) and saves only the general
 * questions and answers in the About text, the place answered caller questions go too (knowledgeQuestion.answer,
 * answeredQuestionLine). Never an email or anyone's personal data.
 */
export const emailKnowledgeHow = (who: string, w: string) =>
  english.t('server.setupAgent.mcp.emailKnowledge', {
    who,
    claude: CLAUDE_CONNECTORS_URL,
    chatgpt: CHATGPT_PLUGINS_URL,
    line: 'If a caller asks "<question>": <answer>',
    save: `assistant_update { ${w}, assistantId, business_profile }`,
  })

/**
 * How the phone step gets a number, by the workspace's country: buying in a country of the buy offers (numberBuyOffers:
 * the US, Canada and Puerto Rico by area code; Germany in the area codes the server offers, once it has German numbers
 * on); elsewhere attaching a number the business already has. `w` is the workspace argument the tool calls carry;
 * `country` null: nothing names the workspace's country yet. `account`: the carrier account the workspace's numbers are
 * set up in. On the install's account (the default) a setup key never attaches a number that is already there (only an
 * instance admin does, in the app: attachRefused in handlers.ts), so the agent buys a new one by area code.
 */
export function numberSetupHow(
  w: string,
  country: string | null,
  web = webAddress(),
  offers: readonly BuyOffer[] = BASE_BUY_OFFERS,
  account: CarrierAccount = 'install',
): string {
  const buying = offers.filter(o => o.ready)
  const countries = buying.map(o => o.country).join(', ')
  const offer = country ? buyOfferIn(buying, country) : undefined

  const listed = `phoneNumber_listCarrierNumbers { ${w} } lists the numbers in the carrier account that are free to attach`
  // On the install's carrier a number already in an account is connected in the app, never with these tools.
  const ownAccount = account === 'workspace'
  const attach = ownAccount
    ? english.t('server.setupAgent.attachOwnAccount', { listed, w })
    : english.t('server.setupAgent.attachInApp', { web })
  // Nothing names the workspace's country yet: the area code picks it, and the bought number sets it.
  if (country === null)
    return `phoneNumber_setup { ${w}, areaCode, purchase: true, mode } buys one, with an area code where the business is (numbers can be bought in ${countries}; the workspace's country is not set yet, so the number sets it). If the business is elsewhere, set its country first (workspace_updateSettings { ${w}, country }); say the cost and ask first. ${attach}`
  // Offered here but not ready yet (German numbers off, or the carrier setup missing): the app says numbers are being set
  // up; the business continues now and connects its number later.
  if (country && !offer && buyOfferIn(offers, country))
    return ownAccount
      ? english.t('server.setupAgent.phoneBeingSetUp', { country, listed, w })
      : english.t('server.setupAgent.phoneBeingSetUpInstall', { country, attach })
  if (offer?.numberType === 'national')
    return `phoneNumber_setup { ${w}, purchase: true, mode } buys one, without an area code (numbers in ${country} have none; numbers can be bought in ${countries}); say the cost and ask first. ${attach}`
  if (offer?.areaCodes)
    return `phoneNumber_setup { ${w}, areaCode, purchase: true, mode } buys one, with an area code this server offers in the workspace's country (${country}: ${offer.areaCodes.join(', ')}, digits without the leading 0; numbers can be bought in ${countries}); say the cost and ask first. ${attach}`
  if (offer)
    return `phoneNumber_setup { ${w}, areaCode, purchase: true, mode } buys one, with an area code in the workspace's country (${country}; numbers can be bought in ${countries}); say the cost and ask first. ${attach}`
  return `Numbers can be bought only for workspaces in ${countries}; this one is in ${country}, so buying is refused. ${attach} If the country is wrong, fix it first (workspace_updateSettings { ${w}, country }).`
}

/**
 * Where the workspace can buy a number: its carrier account's buy offers (numberBuyOffers), that account
 * (numberSetupHow's last two arguments) and its carrier's name (the price: numberPriceHow).
 */
async function buyOffersOf(
  workspaceId: string,
): Promise<{ offers: BuyOffer[]; account: CarrierAccount; provider: string | null }> {
  try {
    const { account, provider } = await telephonyForWorkspace(db, workspaceId)
    return { offers: await numberBuyOffers(db, { account, provider: provider.name }), account, provider: provider.name }
  } catch {
    // No carrier set up (or its keys unreadable): the install's, with the offers every install has; buying fails later
    // with its reason.
    return { offers: [...BASE_BUY_OFFERS], account: 'install', provider: null }
  }
}

/** A carrier's list price in dollars ("$1", "$1.15"). */
const listPrice = (amount: number) => `$${amount.toFixed(amount % 1 ? 2 : 0)}`

/**
 * What a new number costs, for the phone step, by the rule of the app's note under the area code (PhoneStep and
 * Settings, Phone numbers: billedNumberNote, priceNote): a white-label client names no price (its partner pays); on a
 * bill (`extraNumberCents`, from the billing rules) and the install's carrier account the first number is included in
 * the plan and each further one costs `extraNumberCents` a month; otherwise the carrier's list price in `country`, or in
 * each country numbers can be bought in while none is known. `bought`: the workspace's numbers bought on the install's
 * carrier account.
 */
export function numberPriceHow(o: {
  who: string
  partnerManaged: boolean
  extraNumberCents: number | null
  account: CarrierAccount
  provider: string | null
  bought: number
  country: string | null
  offers: readonly BuyOffer[]
}): string {
  if (o.partnerManaged) return english.t('server.setupAgent.numberPrice.partner')
  if (o.provider === 'dev') return english.t('server.setupAgent.numberPrice.dev')
  if (o.extraNumberCents !== null && o.account === 'install')
    return o.bought < 1
      ? english.t('server.setupAgent.numberPrice.included', { who: o.who })
      : english.t('server.setupAgent.numberPrice.extra', { price: dollars(o.extraNumberCents) })
  const carrier = o.provider ? CARRIER_LABELS[o.provider] : undefined
  if (!o.provider || !carrier) return english.t('server.setupAgent.numberPrice.unknown')
  const prices = NUMBER_LIST_PRICES[o.provider] ?? {}
  const countries = o.country ? [o.country] : o.offers.filter(offer => offer.ready).map(offer => offer.country)
  // The same price once, with the countries it is for ("$1 in US, CA, DE, $3 in PR"); one country: the price alone.
  const byPrice = new Map<number, string[]>()
  for (const country of countries) {
    const amount = prices[country]
    if (amount === undefined) return english.t('server.setupAgent.numberPrice.carrierUnknown', { carrier })
    byPrice.set(amount, [...(byPrice.get(amount) ?? []), country])
  }
  if (!byPrice.size) return english.t('server.setupAgent.numberPrice.carrierUnknown', { carrier })
  if (o.country)
    return english.t('server.setupAgent.numberPrice.carrier', { price: listPrice(prices[o.country]!), carrier })
  return english.t('server.setupAgent.numberPrice.carrierByCountry', {
    prices: [...byPrice].map(([amount, list]) => `${listPrice(amount)} in ${list.join(', ')}`).join(', '),
    carrier,
  })
}

async function workspaceSteps(actor: Actor, advance: boolean): Promise<StepBase[]> {
  const workspaceId = actor.workspaceId!
  // Every business tool names this workspace.
  const w = `workspaceId: "${workspaceId}"`
  // Who the agent talks to: the instance admin, or on a workspace link its owner or admin.
  const who = personOf(actor)
  const [ws] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, workspaceId))
  const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const assistant = await firstAssistant(workspaceId)
  const locale = await workspaceLocale(db, workspaceId, settings ?? null)
  const numbers = await db
    .select({
      id: phone_numbers.id,
      e164: phone_numbers.e164,
      mode: phone_numbers.mode,
      purchased: phone_numbers.purchased,
      carrier_account: phone_numbers.carrier_account,
    })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspaceId))
  const golive = await goLiveChecklist(db, actor)
  const profile = (assistant?.business_profile ?? {}) as Record<string, unknown>
  const hasProfile = Object.values(profile).some(v => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
  const forwarding = numbers.find(n => n.mode === 'forward_conditional' || n.mode === 'forward_all')
  // What is done follows the data, so an agent that saves a step without moving onboarding on still sees it done; a
  // step onboarding went past is done too, also when the owner chose "Finish later" after it (`went`). The assistant
  // and who hears about calls are choices with defaults: done once changed, or passed.
  const step = settings?.onboarding_step
  const went = await stepReached(workspaceId, step)
  // A workspace on a Linedesk Cloud bill is served only in the sign-up countries (served-countries.ts): one whose
  // country is another (worked out from where its owner signed up, say) needs a served one set before the business
  // step counts as done, as Checkout refuses it otherwise.
  const served = await servedCountriesOf(db, workspaceId)
  const countryUnserved = !!served && !served.includes(locale.resolvedCountry)
  const businessDone = (hasProfile || past(went, 'business')) && !countryUnserved
  const phoneDone = numbers.length > 0
  // A workspace set up before the choice was stored answers with the default: done once onboarding went past it.
  const pickupDone = Boolean(settings?.pickup_mode) || past(went, 'pickup')
  const fresh = newAssistant(workspaceId, ws?.name ?? '', [], 'standard')
  const assistantChanged =
    !!assistant && (assistant.name !== DEFAULT_ASSISTANT_NAME || assistant.greeting !== fresh.greeting)
  const assistantDone = assistantChanged || past(went, 'assistant')
  const [notifyRow] = await db
    .select({ user_id: member_notification_settings.user_id })
    .from(member_notification_settings)
    .where(eq(member_notification_settings.workspace_id, workspaceId))
    .limit(1)
  // The "Who hears about calls?" step saves a member's notifications and its own transfer contact (id "urgent",
  // URGENT_CONTACT_ID in apps/web/src/onboarding/flow.ts); kept as it was, it saves nothing: then passing it counts.
  const notifyDone = !!notifyRow || !!assistant?.transfers.some(t => t.id === URGENT_CONTACT_ID) || past(went, 'notify')
  // A Linedesk Cloud sign-up waiting for its trial: the free steps first, then the owner's card
  // (`activate`, on the setup page, never the agent's), and only then a number (refused before, self-serve.ts).
  const waitingForTrial = await waitsForOwnTrial(db, workspaceId)
  // A white-label partner's draft client workspace (setup before payment, 2026-11-18): set up like any, but its number
  // waits for the partner's Checkout (the partner's Activate row), not a trial of its own.
  const waitingForPartner = !waitingForTrial && (await isPendingPayment(db, workspaceId))
  // Once that trial (or plan) started, its row stays as done: the count goes on (4 of 7 → 7 of 7), never one row fewer.
  const started = waitingForTrial ? null : await ownStartOf(workspaceId)
  // The bill as the app reads it (billing-page.ts): the trial's days while it waits (null: no trial, the plan), the
  // number's price on a bill, a white-label client's partner paying.
  const bill = await workspaceBillFacts(workspaceId)
  const trial = waitingForTrial ? bill.trialDays !== null : (started?.trial ?? true)
  const freeStepsDone = businessDone && assistantDone && pickupDone && notifyDone
  // On Ultra the assistant speaks in the realtime model's voices, not one of the voice provider's (like Assistant settings).
  const realtime = assistant?.call_quality === 'ultra' && (await pipelinesSetUp(db)).realtime
  // Onboarding in the app resumes where the agent got to (never moved back): through the registry, as the admin. The
  // one write of reading the status: bookkeeping, nothing the admin would be asked about.
  const reached =
    waitingForTrial && freeStepsDone
      ? 'activate'
      : phoneDone && businessDone && pickupDone && !waitingForTrial
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
  // How the phone step gets a number, in the country the owner was shown (buyingCountryOf: the same rule as the app's
  // phone step and the server's purchaseCountry, so no area code is offered that the server refuses), then what it
  // costs, by the bill (numberPriceHow).
  const phoneHow = async () => {
    const { offers, account, provider } = await buyOffersOf(workspaceId)
    const named = countryNamed(locale.countrySource)
    const country = buyingCountryOf({ country: locale.resolvedCountry, source: locale.countrySource }, offers)
    const ready = offers.filter(o => o.ready)
    const buying = !country || Boolean(buyOfferIn(ready, country))
    return [
      numberSetupHow(w, country, webAddress(), offers, account),
      ...(country && !named
        ? [english.t('server.setupAgent.phoneCountryGuessed', { country, source: locale.countrySource, w })]
        : []),
      ...(buying
        ? [
            numberPriceHow({
              who,
              partnerManaged: bill.partnerManaged,
              extraNumberCents: bill.extraNumberCents,
              account,
              provider,
              bought: numbers.filter(n => n.purchased && n.carrier_account === 'install').length,
              country,
              offers,
            }),
          ]
        : []),
    ]
  }
  return [
    {
      // The business as the person sees it, one step: the workspace (name, time zone, country) and what
      // the assistant knows about it. Done once the profile is (the workspace exists whenever this list does).
      id: 'business',
      label: BUSINESS_STEPS[0][1],
      state: done(businessDone),
      // The name is a member's text: quoted, as data.
      detail: `${JSON.stringify(ws?.name ?? '')} (${workspaceId}), time zone ${settings?.timezone ?? 'unknown'}, country ${locale.resolvedCountry}${locale.country ? '' : ` (automatic, ${locale.countrySource})`}, language ${locale.resolvedLanguage} (from the country), assistant ${assistant?.id ?? 'none'}`,
      how: [
        ...(countryUnserved
          ? [
              english.t('server.setupAgent.countryNotServed', {
                served: served!.join(', '),
                country: locale.resolvedCountry,
                how: locale.country ? 'set' : `only worked out, from ${locale.countrySource}`,
                who,
                call: `workspace_updateSettings { ${w}, country }`,
              }),
            ]
          : []),
        `Check the name, time zone and country with the ${who}: workspace_rename { ${w}, name }, workspace_updateSettings { ${w}, timeZone, country } (ISO country code, now ${locale.resolvedCountry}; null: automatic). The country is the default for phone numbers, the forwarding guide, holidays and currency, and the region numbers callers say are read in; its main language is what call summaries are written in and what the assistant greets in unless it has its own main language (assistant_update languages.main).`,
        `business_search { ${w}, query: "<name> <city>" } finds the listing (when business lookup is set up); business_import { ${w}, assistantId: "${assistant?.id ?? ''}", placeId?, name?, website? } drafts a profile from the listing and the website. It changes nothing.`,
        `Show the ${who} a short summary (services, area, hours, what to say about prices), fix what they correct, then save it: assistant_update { ${w}, assistantId, business_profile }. Opening hours: businessHours_set { ${w}, … }.`,
        emailKnowledgeHow(who, w),
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
      label: BUSINESS_STEPS[3][1],
      state: done(notifyDone),
      how: [
        `What it is for, in plain words: after every call the ${who} gets an email with a short summary, and a caller with something urgent can be put through to their mobile. Turn the email on (notifications_update { ${w}, email: true }) and say so.`,
        `Suggest putting urgent calls through to the ${who}'s own mobile and ask only for the number; save it in the assistant's transfers (assistant_update { ${w}, assistantId, transfers }). Say it in plain words ("urgent calls go to your mobile"), never "transfers".`,
        `Then onboarding_setStep { ${w}, step: "${waitingForTrial ? 'activate' : 'phone'}" }.`,
      ],
    },
    ...(waitingForTrial
      ? [
          {
            id: 'activate',
            // "Start your free trial", or "Start your plan" where none is offered (refused, or the card had one), as the
            // setup page's row and its button say (AgentSetup, SetupStartTrial).
            label: english.t(trial ? 'onboarding.steps.activate' : 'onboarding.steps.activatePlan'),
            // The owner's own step, once the free steps are done; the setup page shows it as a row with its button.
            state: freeStepsDone ? 'admin_only' : 'todo',
            how: [
              english.t(trial ? 'server.setupAgent.activateHow' : 'server.setupAgent.activatePlanHow', {
                who,
                page: setupPage(actor),
                seconds: POLL_SECONDS,
              }),
              trial
                ? english.t('server.setupAgent.mcp.trialLinkDays', {
                    who,
                    days: bill.trialDays ?? 0,
                    link: `${webAddress()}${trialStartPath(workspaceId)}`,
                  })
                : english.t('server.setupAgent.mcp.planLink', {
                    who,
                    link: `${webAddress()}${trialStartPath(workspaceId)}`,
                  }),
            ],
          } satisfies StepBase,
        ]
      : started
        ? [
            {
              id: 'activate',
              label: english.t(trial ? 'onboarding.steps.activate' : 'onboarding.steps.activatePlan'),
              state: 'done',
              how: [],
            } satisfies StepBase,
          ]
        : []),
    {
      id: 'phone',
      label: BUSINESS_STEPS[4][1],
      // On a partner's link the number is the owner's own row on the setup page (it costs money), never the agent's.
      state:
        actor.setupPartnerId && !phoneDone && !waitingForTrial && !waitingForPartner ? 'admin_only' : done(phoneDone),
      // The id too: the forwarding tools need it, also while another step is next and this one has no `how`.
      detail: numbers.map(n => `${n.e164} (${n.mode}, phoneNumberId ${n.id})`).join(', ') || null,
      how: waitingForTrial
        ? [english.t(trial ? 'server.setupAgent.phoneAfterTrial' : 'server.setupAgent.phoneAfterPlan', { who })]
        : waitingForPartner
          ? [english.t('server.setupAgent.partner.phoneAfterActivate', { who })]
          : actor.setupPartnerId
            ? [english.t('server.setupAgent.partner.phoneHow', { who, page: setupPage(actor), seconds: POLL_SECONDS })]
            : [
                'What it is for, in plain words: the assistant needs its own phone number. Most businesses keep their number: calls they miss are forwarded to the new Linedesk number (mode "forward_conditional", or "forward_all" for every call). Or callers use the new number directly (mode "new"). Suggest forwarding and ask only to confirm. For forwarding, forwarding_guide { workspaceId, carrier? } shows how it works for the business line\'s carrier already now, before the number exists.',
                ...(await phoneHow()),
                `Then onboarding_setStep { ${w}, step: "done" }.`,
              ],
    },
    ...(forwarding
      ? [
          {
            id: 'forwarding',
            label: 'Forwarding from the business line',
            state: actor.setupPartnerId && !golive.forwardingVerified ? 'admin_only' : done(golive.forwardingVerified),
            how: actor.setupPartnerId
              ? [
                  english.t('server.setupAgent.partner.forwardingHow', {
                    who,
                    page: setupPage(actor),
                    seconds: POLL_SECONDS,
                  }),
                ]
              : [
                  `Ask for the business line's carrier, then forwarding_guide { ${w}, carrier, country, mode: "${forwarding.mode}" } (country: where the business line is, e.g. "US") for the codes to dial on the business phone (they forward to ${forwarding.e164}).`,
                  `After the ${who} dialed them: phoneNumber_checkForwarding { ${w}, phoneNumberId: "${forwarding.id}", businessNumber } calls the business line once; poll phoneNumber_forwardingCheck { ${w}, … } every few seconds while it says dialing.`,
                  actor.setupWorkspaceId
                    ? `The ${who} can also do all of it on the setup page (${webAddress()}/#setup-agent): "Set up forwarding" on the Call forwarding row shows the codes for their carrier and runs the same check.`
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
        `Only the ${who} can do this: they talk to the assistant. Ask them to stay on the setup page (${setupPage(actor)})${actor.setupWorkspaceId ? '' : `, pick ${JSON.stringify(ws?.name ?? '')} in the workspace dropdown`} and click ${JSON.stringify(`Call ${assistant?.name ?? 'Maya'} now`)} on the Test call row: it calls the assistant with their microphone, right there, and the step is done once the assistant answered.${numbers[0] ? ` Or they call ${numbers[0].e164} from another phone.` : ''}`,
        `Call setup_status { read_only: true } every ${POLL_SECONDS} seconds or when they say they talked to it, until test_call is done.`,
      ],
    },
  ]
}

/**
 * A guide's steps for `mode` before the workspace has a number to forward to: the codes or settings as the guide
 * writes them, with {number} (and {digits}) where the assistant's number goes; null when the guide has no way for it.
 */
export function instructionsBeforeNumber(guide: ForwardingGuide, mode: ForwardingMode) {
  if (guide.how === 'dial') {
    const steps = guide.modes[mode]
    if (!steps) return null
    const codes = (list: readonly DialCode[]) => list.map(c => ({ code: c.code, ...(c.when ? { when: c.when } : {}) }))
    return { how: 'dial' as const, on: codes(steps.on), off: codes(steps.off), check: codes(guide.check ?? []) }
  }
  const steps = guide.modes[mode]
  if (!steps) return null
  return {
    how: 'settings' as const,
    where: guide.where,
    on: [...steps.on],
    off: [...steps.off],
    check: guide.check ?? null,
  }
}

function registerTools(server: McpServer, actor: Actor) {
  const read = { readOnlyHint: true }
  const who = personOf(actor)
  // A workspace owner's or a partner owner's link: no server tools at all, only the workspace's (agent-setup.ts).
  const serverTools = !actor.setupWorkspaceId && !actor.setupPartnerId
  server.registerTool(
    'setup_status',
    {
      description: `Start here, and call again after every step: what is set up, what is missing or failing, and for the next step exactly what to do (pages, clicks, tool calls). Also links into the app for what only the ${who} can do there. It never changes a setting; it only notes how far the setup got (the step the app opens on). With read_only: true it notes nothing either: use that to wait.`,
      inputSchema: z.object({
        read_only: z
          .boolean()
          .optional()
          .describe(`true: only read, note nothing (for waiting, e.g. for the ${who}'s test call)`),
      }),
      annotations: read,
    },
    async (input: { read_only?: boolean }) =>
      guard(actor, 'setup_status', async () => answer(await setupStatus(actor, { advance: !input?.read_only }), actor)),
  )
  if (serverTools)
    server.registerTool(
      'providers_list',
      {
        description:
          'The providers this install can use, by category (telephony, stt, llm, tts, realtime, email, sign_in, recording, transcript, business, apps; billing keys are set only in the app): their fields (name, whether secret, optional), which one is picked, which fields are set (never a value) and help text. Use the field names with provider_setKeys.',
        inputSchema: z.object({
          category: z
            .enum(
              [...categoryNames].filter(c => !moneyCategories.includes(c as ProviderCategory)) as [ProviderCategory],
            )
            .optional(),
        }),
        annotations: read,
      },
      async ({ category }) =>
        guard(actor, 'providers_list', async () => {
          const status = await providerStatus(db)
          const rows = status.providers
            .filter(p => (!category || p.category === category) && !moneyCategories.includes(p.category))
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
                help: providerHelp(p.provider),
                ...(spec.category === 'sign_in' || spec.category === 'apps'
                  ? { redirect_uris: redirectUris(p.provider) }
                  : {}),
              }
            })
          return answer({
            categories: Object.fromEntries(categoryNames.map(c => [c, providerCategoryLabel(c)])),
            providers: rows,
          })
        }),
    )
  if (serverTools)
    server.registerTool(
      'workspace_create',
      {
        description: `Create a business (a workspace) with its assistant: one per business or location the admin runs (this setup link makes at most ${SETUP_LINK_WORKSPACE_CAP}). They become its owner. Ask for the name first; never make the same business twice (setup_status.workspaces lists the ones there are). Returns its id: pass it as workspaceId to the business tools, then follow setup_status. Only for businesses the admin runs themselves: a business for someone else is created in Server admin › Workspaces › New workspace with its owner's email.`,
        inputSchema: z.object({
          name: z.string().trim().min(1).max(80).describe("The business's name, as callers know it"),
          timeZone: z.string().max(64).optional().describe('IANA time zone, e.g. America/Los_Angeles'),
        }),
      },
      async ({ name, timeZone }) =>
        guard(actor, 'workspace_create', async () => {
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
        "How to forward a workspace's business line to its assistant's number: codes to dial (or settings to change) for the line's carrier or phone system, to turn forwarding on and off. Pass the business line's country (ISO 3166-1 alpha-2, e.g. \"US\", \"GB\"; default the workspace's country): the guides are that country's carriers and regional phone systems plus the international phone systems (RingCentral, Dialpad, 8x8, Teams Phone, 3CX …, listed in every country), and the number is written the way that country dials it. A country without carrier guides of its own gets the standard GSM codes and the phone's own settings (the answer's `countries` lists the countries with carrier guides). Without a carrier it lists the country's carriers and phone systems to ask which one the line uses. It works before the assistant has a number too: the codes then show {number} where the assistant's number goes; call it again once phoneNumber_setup made one in a forwarding mode.",
      inputSchema: z.object({
        carrier: z
          .string()
          .trim()
          .min(2)
          .max(60)
          .optional()
          .describe(
            'The business line\'s carrier or phone system, e.g. "Verizon", "RingCentral"; leave it out to list the ones there are guides for',
          ),
        country: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, 'a two-letter country code (ISO 3166-1 alpha-2), e.g. US or GB')
          .transform(c => c.toUpperCase())
          .optional()
          .describe(
            'The country the business line is in (ISO 3166-1 alpha-2, e.g. "US", "CA", "GB"); default the workspace\'s country (workspace settings, else worked out from its numbers)',
          ),
        mode: z.enum(['forward_conditional', 'forward_all']).default('forward_conditional'),
        workspaceId: workspaceIdField,
      }),
      annotations: read,
    },
    async ({ carrier, country: asked, mode, workspaceId }) =>
      guard(actor, 'forwarding_guide', async () => {
        const inWs = await setupActorIn(actor, workspaceId)
        if (!inWs?.workspaceId) return refusal(notYourWorkspace(actor), actor)
        const [number] = await db
          .select({ e164: phone_numbers.e164 })
          .from(phone_numbers)
          .where(and(eq(phone_numbers.workspace_id, inWs.workspaceId), eq(phone_numbers.mode, mode)))
          .limit(1)
        // A country without guides of its own gets the "Other country" guides (standard GSM codes, phone settings).
        const requested = asked ?? (await workspaceLocale(db, inWs.workspaceId)).resolvedCountry
        const country = hasForwardingCountry(requested) ? requested : OTHER_COUNTRY
        const countries = forwardingCountries.map(c => c.code)
        // The country's carriers, or the "Other country" ones, and the phone systems sold in the country asked for.
        const guides = carrier ? searchForwardingGuides(carrier, requested).slice(0, 3) : []
        const shown = guides.length ? guides : guidesForCountry(country).slice(0, country === OTHER_COUNTRY ? 2 : 0)
        // No carrier named yet: the ones to pick from, so the agent can ask which one the business line uses.
        if (!carrier && !shown.length)
          return answer(
            {
              forward_to: number?.e164 ?? null,
              country: requested,
              countries,
              carriers: guidesForCountry(country).map(g => ({ id: g.id, name: g.name, kind: g.kind })),
              next: 'Ask which of these carriers or phone systems the business line uses (or its name), then call forwarding_guide again with carrier.',
            },
            actor,
          )
        if (!shown.length)
          return refusal(
            `no guide for "${carrier}" in ${requested}: ask for the carrier's name, or a mobile/landline/phone system. Countries with guides: ${countries.join(', ')}; any other country gets the standard codes.`,
            actor,
          )
        // The best match decides: a carrier that forwards only within its country can't reach a number abroad.
        const warning = number ? abroadWarning(number.e164, requested, shown[0]) : null
        return answer(
          {
            forward_to: number?.e164 ?? null,
            country: requested,
            ...(number
              ? {}
              : {
                  no_number_yet: `The workspace has no number in mode ${mode} yet: {number} in the codes is where the assistant's number goes. Set one up first (phoneNumber_setup), then call forwarding_guide again for the codes with it filled in.`,
                }),
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
              instructions: number
                ? forwardingInstructions(guide, mode as ForwardingMode, number.e164, requested)
                : instructionsBeforeNumber(guide, mode as ForwardingMode),
            })),
          },
          actor,
        )
      }),
  )
  server.registerTool(
    'setup_endAccess',
    {
      description: `End your access at the end of the setup: the setup link you are using stops working at once (only this one). Call it last, after your summary to the ${who}. setup_status.wrap_up says when; with steps still open, ask the ${who} first. Every later call with this link is refused. The ${who} can make a new link at any time.`,
      inputSchema: z.object({}),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async () =>
      guard(actor, 'setup_endAccess', async () => {
        const { body } = await runAction('agentSetup.endOwnAccess', {}, actor)
        if (!body.ok) return refusal(body.error, actor)
        return answer(
          {
            ok: true,
            ended: true,
            message: `Your access has ended: this setup link no longer works. The setup page tells the ${who}; they can make a new link at any time. Tell them in one line that you ended it.`,
          },
          actor,
        )
      }),
  )
  if (serverTools) registerSetupReport(server, actor)
  // A workspace key is offered only what its role may do (an admin's never an owner-only tool); setupActorIn and
  // runAction refuse the rest anyway.
  const role = actor.setupWorkspaceRole
  for (const name of SETUP_ACTIONS) {
    const def = actions.get(name)
    if (!def || (!serverTools && isServerAction(name))) continue
    if (role && !rolePermissions[role].includes(def.permission)) continue
    // A partner's link: the workspace setup only, never a number, a forwarding check or a lookup (owner rows).
    if (actor.setupPartnerId && !PARTNER_KEY_WORKSPACE_ACTIONS.has(name)) continue
    registerAction(server, def, actor)
  }
  if (actor.setupPartnerId)
    for (const name of PARTNER_KEY_PARTNER_ACTIONS) {
      const def = actions.get(name)
      if (def) registerPartnerAction(server, def, actor, actor.setupPartnerId)
    }
}

/** What the setup report tool says about itself (install links only; the agent reads it). */
export const SETUP_REPORT_TOOL_DESCRIPTION = english.t('server.setupAgent.report.toolDescription')

/** The setup report's input on the setup MCP: feedback.send's setup fields, `setup` required, the text as its summary. */
function setupReportInput() {
  const shape = (actions.get('feedback.send')!.input as z.ZodObject).shape as Record<string, z.ZodType>
  return z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(SETUP_REPORT_SUMMARY_MAX)
      .describe("How the setup went, in one or two sentences (the report's summary)"),
    setup: (shape.setup as z.ZodOptional<z.ZodObject>).unwrap(),
    contact_email: shape.contact_email!,
    user_consented: shape.user_consented!,
  })
}

/** What the agent tells the admin after the admin's yes, by how sending went. */
function sentMessage(row: { status: string; remote_id: string | null; last_error: string | null }) {
  if (row.status === 'sent') return english.t('server.setupAgent.report.sent', { id: row.remote_id ?? '' })
  if (row.status === 'refused') return english.t('server.setupAgent.report.refused', { why: row.last_error ?? '' })
  if (row.last_error === SENDING_OFF) return english.t('server.setupAgent.report.off')
  return english.t('server.setupAgent.report.kept', { why: row.last_error ?? row.status })
}

/**
 * feedback_send on an install link (LIN-210): a setup report to the Linedesk team, feedback.send with kind setup. Without
 * user_consented it only builds the redacted preview and the consent words; with it, feedback.send stores and sends the
 * report (runAction waits for the try), and the answer says how that went.
 */
function registerSetupReport(server: McpServer, actor: Actor) {
  server.registerTool(
    toolName('feedback.send'),
    {
      description: SETUP_REPORT_TOOL_DESCRIPTION,
      inputSchema: setupReportInput() as never,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ((raw: z.infer<ReturnType<typeof setupReportInput>>) =>
      guard(actor, 'feedback.send', async () => {
        const input = { ...raw, kind: 'setup' as const } as SetupReportInput
        if (raw.user_consented !== true) {
          const preview = await buildSetupReport(db, actor, input)
          return answer({
            ok: true,
            sent: false,
            preview,
            ask: consentText(preview),
            next: english.t('server.setupAgent.report.next'),
          })
        }
        // feedback.send is open to every member (call:read); an install link's actor holds only the admin's rights,
        // so it gets that one right for this one action.
        const { body } = await runAction('feedback.send', input, {
          ...actor,
          permissions: [...actor.permissions, 'call:read'],
        })
        if (!body.ok) return refusal(body.error, actor)
        const { id } = body.data as { id: string }
        const [row] = await db
          .select({ status: feedback.status, remote_id: feedback.remote_id, last_error: feedback.last_error })
          .from(feedback)
          .where(eq(feedback.id, id))
        return answer({
          ok: true,
          id,
          status: row!.status,
          ...(row!.remote_id ? { remote_id: row!.remote_id } : {}),
          message: sentMessage(row!),
        })
      })) as never,
  )
}

/**
 * A partner's own action on a partner owner's link: its partnerId is the link's, filled in here and never asked for,
 * so the agent cannot name another partner (run-action.ts refuses that too, partnerKeyOutOfScope).
 */
function registerPartnerAction(server: McpServer, def: ActionDef, actor: Actor, partnerId: string) {
  const inputSchema = (def.input as z.ZodObject).omit({ partnerId: true })
  server.registerTool(
    toolName(def.name),
    {
      description: def.description,
      inputSchema: inputSchema as never,
      annotations: { readOnlyHint: Boolean(def.readOnly) },
    },
    ((raw: unknown) =>
      guard(actor, def.name, async () => {
        const { body } = await runAction(def.name, { ...((raw as object) ?? {}), partnerId }, actor)
        if (!body.ok) return refusal(body.error, actor)
        return answer({ ok: true, rows: body.rows, ...(body.data ? { data: body.data } : {}) }, actor)
      })) as never,
  )
}

/** The setup tools for this setup key's admin (or, for a workspace key, its owner or admin, by that role). */
export function setupMcpServerFor(actor: Actor) {
  const instructions = actor.setupPartnerId
    ? setupMcpPartnerInstructions()
    : actor.setupWorkspaceId
      ? SETUP_MCP_WORKSPACE_INSTRUCTIONS
      : SETUP_MCP_INSTRUCTIONS
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
    // Not the SDK's connection headers (keep-alive.ts).
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: withoutHopByHopHeaders(res.headers),
    })
  } catch (e) {
    release()
    throw e
  }
}
