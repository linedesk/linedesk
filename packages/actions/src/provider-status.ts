// Providers in one place (LIN-158): the groups of providers, in the same order and with the same ids everywhere
// (Server admin › Providers, the "Ready for calls" card on the admin overview, the install walkthrough, the setup MCP
// and `scripts/setup.sh --check`), and the one status function that turns what is known about each provider into one
// status per group, in the same words. Pure: the API brings the facts from the database, the web app from the admin
// data plus the tests it runs right now.
import { type ProviderCategory, type ProviderName, providerSpec, providersIn } from './admin.ts'
import { type ProviderFailure, providerFailureReasonLabels } from './provider-health.ts'
import { pipelineFor, type VoicePipeline } from './settings.ts'

export const providerGroupIds = [
  'email',
  'telephony',
  'answering',
  'call-audio',
  'sign-in',
  'calendar',
  'recording',
  'transcript',
  'business',
  'billing',
] as const
export type ProviderGroupId = (typeof providerGroupIds)[number]
export const isProviderGroupId = (value: string): value is ProviderGroupId =>
  (providerGroupIds as readonly string[]).includes(value)

export type ProviderGroupSpec = {
  id: ProviderGroupId
  label: string
  /** A first answered call needs it. The others are optional: "Off" until set up. */
  needed: boolean
  /** The categories whose providers it lists, in order; none for call audio (LiveKit and SIP, set in .env). */
  categories: readonly ProviderCategory[]
  /** Only these providers of its categories (calendar: the sign-in apps that also connect calendars). */
  only?: readonly ProviderName[]
  why: string
}

/** The OAuth apps that connect calendars: Google's and Microsoft's also serve sign-in; Calendly's and Cal.com's only calendars. */
export const CALENDAR_APPS: readonly ProviderName[] = ['google', 'microsoft', 'calendly', 'calcom']
/** The apps people sign in with (the rest of the sign-in category connects calendars only). */
export const SIGN_IN_APPS: readonly ProviderName[] = ['google', 'microsoft', 'github', 'oidc']
/** The three stages that answer calls when no realtime model does. */
export const STAGE_CATEGORIES = ['stt', 'llm', 'tts'] as const satisfies readonly ProviderCategory[]

export const providerGroups: readonly ProviderGroupSpec[] = [
  {
    id: 'email',
    label: 'Email',
    needed: true,
    categories: ['email'],
    why: 'Sign-in codes, invitations and call emails.',
  },
  {
    id: 'telephony',
    label: 'Phone carrier',
    needed: true,
    categories: ['telephony'],
    why: 'Gives the business a number and brings its calls in.',
  },
  {
    id: 'answering',
    label: 'Answering calls',
    needed: true,
    categories: ['realtime', ...STAGE_CATEGORIES],
    why: 'Two ways to answer. Either one realtime model that listens, thinks and speaks. Or three parts: speech to text, a language model and a voice.',
  },
  {
    id: 'call-audio',
    label: 'Call audio',
    needed: true,
    categories: [],
    why: 'LiveKit and its SIP bridge carry the call audio. Set in .env on the server.',
  },
  {
    id: 'sign-in',
    label: 'Sign-in',
    needed: false,
    categories: ['sign_in'],
    only: SIGN_IN_APPS,
    why: 'Sign in with Google, Microsoft, GitHub or your own single sign-on.',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    needed: false,
    categories: ['sign_in'],
    only: CALENDAR_APPS,
    why: 'Bookings in Google or Microsoft calendars (the same apps as for sign-in), and one-click connecting for Calendly and Cal.com. iCloud and other CalDAV calendars need no app; without an app, Calendly and Cal.com connect with a key.',
  },
  {
    id: 'recording',
    label: 'Recording storage',
    needed: false,
    categories: ['recording'],
    why: 'Where call recordings are kept. Off: calls are not recorded.',
  },
  {
    id: 'transcript',
    label: 'After-call transcription',
    needed: false,
    categories: ['transcript'],
    why: 'After each call, the recording file is uploaded to the provider you select, which transcribes it again; the caller’s lines of the transcript are corrected. Off until you select one.',
  },
  {
    id: 'business',
    label: 'Business lookup',
    needed: false,
    categories: ['business'],
    why: 'Finds a business by name and city in onboarding and fills in its details.',
  },
  {
    id: 'billing',
    label: 'Billing',
    needed: false,
    categories: ['billing'],
    why: 'Linedesk Cloud only: bills, trials and call minutes through Stripe. Off until Stripe is connected and billing is turned on; a self-hosted install bills nobody.',
  },
]
export const groupSpec = (id: ProviderGroupId) => providerGroups.find(g => g.id === id)!
export const neededGroupIds = providerGroups.filter(g => g.needed).map(g => g.id)

/** The providers a group lists. */
export const providersOfGroup = (id: ProviderGroupId): ProviderName[] => {
  const spec = groupSpec(id)
  return spec.categories.flatMap(c => providersIn(c)).filter(p => !spec.only || spec.only.includes(p))
}

/** The group a provider is managed in (Google and Microsoft: sign-in, they show under calendar too). */
export function groupOfProvider(provider: ProviderName): ProviderGroupId {
  const category = providerSpec(provider).category
  return providerGroups.find(g => g.categories.includes(category) && (!g.only || g.only.includes(provider)))!.id
}

/** A category's group: old links like #admin/providers/stt land on Answering calls. */
export const groupOfCategory = (category: ProviderCategory): ProviderGroupId =>
  providerGroups.find(g => g.categories.includes(category))!.id

/** Whether a provider belongs to a group that a first answered call needs (the health check emails about these). */
export const isNeededProvider = (provider: ProviderName) => groupSpec(groupOfProvider(provider)).needed

/** How to make call audio work: part of the install, set up on the server (scripts/setup.sh, docker compose). */
export const callAudioGuide = {
  url: 'https://docs.livekit.io/home/self-hosting/ports-firewall/',
  steps: [
    'docker compose up starts LiveKit and its SIP bridge; scripts/setup.sh puts their keys in .env.',
    'Open the SIP port (5060) and LiveKit’s audio ports in your firewall, so carriers reach this server.',
    'Once a number is connected: docker compose exec agent node apps/agent/src/setup-sip.ts <number> (with pnpm: pnpm --filter @linedesk/agent setup-sip <number>).',
  ],
  cost: 'Nothing extra: it runs on this server.',
} as const

/**
 * One key for the whole Answering group. OpenAI is the only provider in the registry that hears, thinks and speaks in
 * one: its realtime model answers calls (apps/agent/src/config.ts). Speech to text and the language model use the same
 * stored key where those are empty. The action is `provider.connectOneKey` (admin.ts): tested first, stored only when
 * it works. Offered only in Answering's empty state on Server admin › Providers.
 */
export const oneKey = {
  label: 'OpenAI',
  url: 'https://platform.openai.com/api-keys',
  steps: [
    'Sign up at platform.openai.com and add credit (Settings → Billing).',
    'API keys → Create new secret key. Copy the key.',
    'Paste it here.',
  ],
  cost: 'About $0.05 per call minute with gpt-realtime-mini.',
  caveat:
    'Calls are answered by OpenAI Realtime, one speech-to-speech model. Warm transfer, the voice picker and the cached greeting are not available with it; connect speech, model and voice separately for those.',
} as const

// --- Status ------------------------------------------------------------------------------------------------------

/**
 * One status, the same words everywhere. `untested`: keys are there, no test passed or failed for them yet.
 * `not_needed`: a stage of Answering calls that the realtime model makes unnecessary. `off`: an optional group that
 * is not set up.
 */
export type StatusState = 'works' | 'failing' | 'missing' | 'partly' | 'checking' | 'untested' | 'not_needed' | 'off'
export const statusWords: Record<StatusState, string> = {
  works: 'Works',
  failing: 'Failing',
  missing: 'Not set up',
  partly: 'Partly works',
  checking: 'Checking…',
  untested: 'Not tested',
  not_needed: 'Not needed',
  off: 'Off',
}
/** "Failing: Key rejected", "Partly works: voice missing", "Works". */
export const statusText = (s: { state: StatusState; detail: string | null }) =>
  // The word once: a detail that only repeats it ("Failing: Failing") is left out.
  s.detail && (s.state === 'failing' || s.state === 'partly') && s.detail !== statusWords[s.state]
    ? `${statusWords[s.state]}: ${s.detail}`
    : statusWords[s.state]

/** A stored test of the keys in effect (provider_tests). */
export type StoredTest = { ok: boolean; message: string; at: string }
export type ProviderFact = {
  provider: ProviderName
  /** Every field it needs has a value, in the app or on the server. */
  configured: boolean
  /** In use for its category (picked, or the default); sign-in: every configured app. */
  active: boolean
  /** The last test of exactly these keys; 'running' while one runs; null when there is none. */
  test: StoredTest | 'running' | null
  /** When its keys were last saved in the app: a failure from before is about the old keys. */
  keysAt?: string | null
}
export type FailureFact = Pick<ProviderFailure, 'provider' | 'reason' | 'message' | 'last_at'>
export type ServiceCheck = { ok: boolean; message: string }
/** LiveKit as the server sees it: whether it is set in .env, the server and its SIP bridge. */
export type CallAudioFact = { configured: boolean; server: ServiceCheck; sip: ServiceCheck }

export type StatusInput = {
  providers: readonly ProviderFact[]
  failures?: readonly FailureFact[]
  /** Unknown yet (still being read): Checking…. */
  callAudio?: CallAudioFact | null
  /** Each assistant's choice of how its calls are answered (null: the install default); none: the default. */
  assistantPipelines?: readonly (VoicePipeline | null)[]
  /** Email codes go to the API log (EMAIL_TO_LOG): development only. */
  emailToLog?: boolean
  /** TELEPHONY_PROVIDER=dev: the line that says so, when no carrier is in use. */
  devCarrier?: string | null
  /** Sign-in settings were saved but the API still runs with the ones it started with (it restarts to apply them). */
  signInPending?: boolean
}

export type ProviderLine = {
  provider: ProviderName
  label: string
  state: StatusState
  /** What follows the word: a failure's reason, what is missing. */
  detail: string | null
  /** The longer text: a test's result, a failure's message with its fix. */
  message: string | null
  testedAt: string | null
  /** When the failure it shows happened (the recorded failure's latest, or the failing test's time). */
  failedAt?: string | null
}
export type GroupStatus = {
  id: ProviderGroupId
  label: string
  needed: boolean
  state: StatusState
  detail: string | null
  message: string | null
  /** The provider in use (the one to open), null when none or several. */
  provider: ProviderName | null
  /** What is in use, for the row: "Resend", "OpenAI Realtime", "Deepgram, OpenRouter and ElevenLabs". */
  providerLabel: string | null
  testedAt: string | null
  /** The providers in use behind it (Answering calls: the realtime model and the three stages). */
  parts: ProviderLine[]
  /**
   * Answering calls: the providers that answer, one name each ("OpenAI Realtime"; "Deepgram", "OpenAI", "ElevenLabs";
   * all four when assistants choose both ways). Left out by the other groups.
   */
  answeredBy?: string[]
  /** Answering calls: the ways that answer now (the realtime model, the three parts, or both). Left out by the others. */
  answeredWith?: VoicePipeline[]
}
export type StatusGroups = {
  groups: GroupStatus[]
  /** Every needed group works. */
  ready: boolean
}

const labelOf = (p: ProviderName) => providerSpec(p).label
/** "a, b and c" */
export const listWords = (words: readonly string[], last: 'and' | 'or' = 'and') =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`

// The OpenAI tests list the models with the key: they prove the key, not a call round trip.
const keyOnlyChecks = new Set<ProviderName>(['openai_realtime', 'openai_stt', 'openai'])
const testMessage = (provider: ProviderName, message: string) =>
  keyOnlyChecks.has(provider) && message === 'Connected' ? 'Key accepted' : message

/**
 * A provider's status. A recorded failure (a call, an email, the health check) beats a stored passing test until a
 * newer test passes; a failing test shows the failure's reason when one is recorded.
 */
export function providerLine(fact: ProviderFact, failures: readonly FailureFact[] = []): ProviderLine {
  const base = { provider: fact.provider, label: labelOf(fact.provider) }
  if (!fact.configured) return { ...base, state: 'missing', detail: null, message: null, testedAt: null }
  if (fact.test === 'running') return { ...base, state: 'checking', detail: null, message: null, testedAt: null }
  const test = fact.test
  const testedAt = test?.at ?? null
  const failure = failures.find(f => f.provider === fact.provider && !(fact.keysAt && f.last_at < fact.keysAt))
  const passedSince = (f: FailureFact) => !!test?.ok && test.at > f.last_at
  if (failure && !passedSince(failure))
    return {
      ...base,
      state: 'failing',
      // An unknown reason adds nothing to "Failing".
      detail: failure.reason === 'unknown' ? null : providerFailureReasonLabels[failure.reason],
      message: failure.message,
      testedAt,
      failedAt: failure.last_at,
    }
  if (!test) return { ...base, state: 'untested', detail: null, message: 'Keys set, not tested yet', testedAt }
  if (!test.ok) return { ...base, state: 'failing', detail: null, message: test.message, testedAt, failedAt: test.at }
  return { ...base, state: 'works', detail: null, message: testMessage(fact.provider, test.message), testedAt }
}

/** Several providers that are all in use: the worst status wins. */
const RANK: StatusState[] = ['failing', 'checking', 'untested', 'partly', 'works']
const worst = (lines: readonly ProviderLine[]) =>
  [...lines].sort((a, b) => RANK.indexOf(a.state) - RANK.indexOf(b.state))[0]!

const missingLine = (p: ProviderName | null, category: ProviderCategory): ProviderLine => ({
  provider: p ?? providersIn(category)[0]!,
  label: p ? labelOf(p) : '',
  state: 'missing',
  detail: null,
  message: null,
  testedAt: null,
})

type GroupBody = Omit<GroupStatus, 'id' | 'label' | 'needed'>
const fromLine = (line: ProviderLine, parts: ProviderLine[] = [line]): GroupBody => ({
  state: line.state,
  detail: line.detail,
  message: line.message,
  provider: line.provider,
  providerLabel: line.label,
  testedAt: line.testedAt,
  parts,
})
const empty = (state: StatusState, message: string | null = null): GroupBody => ({
  state,
  detail: null,
  message,
  provider: null,
  providerLabel: null,
  testedAt: null,
  parts: [],
})

const stageNames: Record<(typeof STAGE_CATEGORIES)[number], string> = {
  stt: 'speech to text',
  llm: 'language model',
  tts: 'voice',
}

/** Answering calls: what actually answers (each assistant's choice, with the fallback the voice agent uses). */
function answering(input: StatusInput, lineOf: (c: ProviderCategory) => ProviderLine | null): GroupBody {
  const realtime = lineOf('realtime')
  const stages = STAGE_CATEGORIES.map(c => lineOf(c) ?? missingLine(null, c))
  const setUp = { realtime: !!realtime, three_stage: stages.every(s => s.state !== 'missing') }
  const choices = input.assistantPipelines?.length ? input.assistantPipelines : [null]
  const answeredBy = new Set(choices.map(choice => pipelineFor(choice, setUp)))
  const onlyRealtime = setUp.realtime && answeredBy.size === 1 && answeredBy.has('realtime')
  const stageParts = stages.map((s, i) =>
    s.state === 'missing' && onlyRealtime
      ? { ...s, state: 'not_needed' as const }
      : s.state === 'missing'
        ? { ...s, label: s.label || stageNames[STAGE_CATEGORIES[i]!] }
        : s,
  )
  const parts = [...(realtime ? [realtime] : []), ...stageParts]
  const threeLabel = listWords(stages.filter(s => s.state !== 'missing').map(s => s.label))
  if (!setUp.realtime && !setUp.three_stage) {
    const missing = STAGE_CATEGORIES.filter((_, i) => stages[i]!.state === 'missing').map(c => stageNames[c])
    if (missing.length === 3) return { ...empty('missing'), parts }
    const failingStage = stages.find(s => s.state === 'failing')
    return {
      state: failingStage ? 'failing' : 'partly',
      detail: failingStage ? (failingStage.detail ?? null) : `${listWords(missing)} missing`,
      message: failingStage?.message ?? `${threeLabel} set up; ${listWords(missing)} missing.`,
      provider: null,
      providerLabel: threeLabel || null,
      testedAt: null,
      parts,
    }
  }
  // The pipelines that answer, and their status: the realtime model, or the three stages together.
  const pipelineLine = (p: VoicePipeline): ProviderLine =>
    p === 'realtime' ? realtime! : { ...worst(stages), label: threeLabel, provider: stages[0]!.provider }
  const used = [...answeredBy]
  const line = worst(used.map(pipelineLine))
  const names = used.map(p => (p === 'realtime' ? realtime!.label : threeLabel))
  const answeredText = `Answered by ${listWords(names, 'and')}${used.length > 1 ? ', as each assistant chose' : ''}.`
  const answerers = used.flatMap(p => (p === 'realtime' ? [realtime!.label] : stages.map(s => s.label)))
  return {
    state: line.state,
    detail: line.detail,
    message: line.state === 'works' ? answeredText : (line.message ?? answeredText),
    provider: used.length === 1 && used[0] === 'realtime' ? realtime!.provider : null,
    providerLabel: listWords(names),
    testedAt: line.testedAt,
    parts,
    answeredBy: [...new Set(answerers)],
    answeredWith: used,
  }
}

function callAudio(fact: CallAudioFact | null | undefined): GroupBody {
  if (!fact) return empty('checking')
  if (!fact.configured) return empty('missing', fact.server.message)
  if (!fact.server.ok) return { ...empty('failing', fact.server.message), detail: 'LiveKit not reachable' }
  if (!fact.sip.ok) return { ...empty('partly', fact.sip.message), detail: 'phone calls (SIP) not set up' }
  return { ...empty('works', `${fact.server.message}; ${fact.sip.message}`), providerLabel: 'LiveKit and SIP' }
}

/**
 * Every group's status from what is known about each provider: `providers` (configured, in use, last test) and the
 * failures recorded since. Needed groups that are not set up are "Not set up"; optional ones are "Off".
 */
export function statusGroups(input: StatusInput): StatusGroups {
  const failures = input.failures ?? []
  const fact = (p: ProviderName) => input.providers.find(f => f.provider === p)
  const line = (p: ProviderName) => providerLine(fact(p)!, failures)
  /** The provider a category uses, when it has all its keys; null when none. */
  const inUse = (category: ProviderCategory) => {
    const used = providersIn(category).find(p => fact(p)?.active && fact(p)?.configured)
    return used ? line(used) : null
  }
  const several = (lines: ProviderLine[]): GroupBody => {
    if (!lines.length) return empty('off')
    const w = worst(lines)
    return {
      ...fromLine(w, lines),
      provider: lines.length === 1 ? w.provider : null,
      providerLabel: listWords(lines.map(l => l.label)),
    }
  }
  const configured = (ps: readonly ProviderName[]) => ps.filter(p => fact(p)?.configured).map(line)
  const body = (id: ProviderGroupId): GroupBody => {
    switch (id) {
      case 'email': {
        const used = inUse('email')
        if (used) return fromLine(used)
        return empty(
          'missing',
          input.emailToLog ? 'Sign-in codes go to the API log (EMAIL_TO_LOG): for development only' : null,
        )
      }
      case 'telephony': {
        const used = inUse('telephony')
        if (used) return fromLine(used)
        return input.devCarrier
          ? { ...empty('works', input.devCarrier), providerLabel: 'Development carrier' }
          : empty('missing')
      }
      case 'answering':
        return answering(input, inUse)
      case 'call-audio':
        return callAudio(input.callAudio)
      case 'sign-in': {
        const apps = several(configured(providersIn('sign_in')))
        // A test passes before the API runs with the new settings: until it restarted, it is not in effect.
        if (!input.signInPending || apps.state === 'off') return apps
        const later = 'saved, takes effect after the API restarts'
        return { ...apps, state: 'partly', detail: later, message: 'Saved, takes effect after the API restarts.' }
      }
      case 'calendar':
        return several(configured(CALENDAR_APPS))
      case 'recording': {
        const used = inUse('recording')
        return used ? fromLine(used) : empty('off')
      }
      case 'transcript': {
        const used = inUse('transcript')
        return used ? fromLine(used) : empty('off')
      }
      case 'business':
        return several(configured(providersIn('business')))
      case 'billing': {
        const used = inUse('billing')
        return used ? fromLine(used) : empty('off')
      }
    }
  }
  const groups = providerGroups.map(spec => {
    const b = body(spec.id)
    // An optional group not set up is Off, never "Not set up".
    const state = !spec.needed && b.state === 'missing' ? 'off' : b.state
    return { id: spec.id, label: spec.label, needed: spec.needed, ...b, state }
  })
  return { groups, ready: groups.filter(g => g.needed).every(g => g.state === 'works') }
}

/** The groups that need attention on the overview: needed ones, and optional ones only while they fail. */
export const overviewGroups = (groups: readonly GroupStatus[]) => groups.filter(g => g.needed || g.state === 'failing')

/** Groups whose failure stops calls from being answered (email failing does not). */
const CALL_GROUPS: readonly ProviderGroupId[] = ['telephony', 'answering', 'call-audio']

/**
 * The overview's headline: ready, calls not answered (a group calls need is failing), something failing, or not
 * set up yet. `reason` names the group and why.
 */
export function readiness(groups: readonly GroupStatus[]): {
  state: 'ready' | 'blocked' | 'failing' | 'missing' | 'checking'
  headline: string
  reason: string | null
} {
  const needed = groups.filter(g => g.needed)
  const failingCall = needed.find(g => CALL_GROUPS.includes(g.id) && g.state === 'failing')
  const reasonOf = (g: GroupStatus) => `${g.label}: ${statusText(g)}`
  if (failingCall) return { state: 'blocked', headline: 'Calls are not answered', reason: reasonOf(failingCall) }
  const failing = groups.find(g => g.state === 'failing')
  if (failing) return { state: 'failing', headline: `${failing.label} is failing`, reason: reasonOf(failing) }
  const missing = needed.filter(g => g.state === 'missing' || g.state === 'partly')
  if (missing.length)
    return {
      state: 'missing',
      headline: 'Not ready for calls yet',
      reason: `${listWords(missing.map(g => g.label))} ${missing.length > 1 ? 'are' : 'is'} not set up.`,
    }
  if (needed.every(g => g.state === 'works')) return { state: 'ready', headline: 'Ready for calls', reason: null }
  return { state: 'checking', headline: 'Checking…', reason: null }
}
