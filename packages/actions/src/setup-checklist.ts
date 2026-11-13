// The instance setup checklist (Admin, Overview; `scripts/setup.sh --check`): one item per part a first answered
// call needs, its state, and a short guide for the provider we recommend. The API fills in the states
// (apps/api/src/setup-checklist.ts); the texts live here so the web app and the terminal say the same.
import type { ProviderCategory, ProviderName } from './admin.ts'

export type SetupItemId = 'email' | 'telephony' | 'stt' | 'llm' | 'tts' | 'livekit'
/** `set_up`: keys are there, but no test has passed or failed for them yet. */
export type SetupItemState = 'missing' | 'set_up' | 'ok' | 'failing'

export type SetupGuide = {
  /** The provider the steps are for; null for LiveKit, which is part of the install. */
  provider: ProviderName | null
  url: string
  steps: readonly string[]
  /** Rough on purpose: "about", list prices, no promises. */
  cost: string
}

export type SetupItemSpec = {
  id: SetupItemId
  label: string
  /** The provider category it checks; null for LiveKit (env, not a provider). */
  category: ProviderCategory | null
  why: string
  guide: SetupGuide
}

export const setupItems: readonly SetupItemSpec[] = [
  {
    id: 'email',
    label: 'Email',
    category: 'email',
    why: 'Sign-in codes, invitations and call emails.',
    guide: {
      provider: 'resend',
      url: 'https://resend.com/api-keys',
      steps: [
        'Sign up at resend.com.',
        'Domains → Add Domain. Add the DNS records it shows and wait until it says Verified.',
        'API Keys → Create API Key, permission Sending access. Copy the key.',
        'Paste it here. From is an address on the verified domain, e.g. desk@yourdomain.com.',
      ],
      cost: 'Free up to about 3,000 emails a month.',
    },
  },
  {
    id: 'telephony',
    label: 'Phone carrier',
    category: 'telephony',
    why: 'Gives the business a number and brings its calls in.',
    guide: {
      provider: 'telnyx',
      url: 'https://portal.telnyx.com/',
      steps: [
        'Create an account at telnyx.com and add a payment method (numbers need a verified account).',
        'Mission Control → Keys & Credentials → API Keys → Create API Key. Copy the key, it is shown once.',
        'Same page, Public Key: copy it. Linedesk checks the signature of Telnyx’s webhooks with it.',
        'Paste both here. The number itself is bought or connected later, in the business onboarding.',
      ],
      cost: 'About $1 a month per US number, plus about half a cent per call minute.',
    },
  },
  {
    id: 'stt',
    label: 'Speech to text',
    category: 'stt',
    why: 'Hears the caller.',
    guide: {
      provider: 'deepgram',
      url: 'https://console.deepgram.com/',
      steps: [
        'Sign up at console.deepgram.com.',
        'API Keys → Create a New API Key, role Member. Copy the key.',
        'Paste it here. Leave the model empty for the default.',
      ],
      cost: 'About $0.008 per call minute; new accounts start with free credit.',
    },
  },
  {
    id: 'llm',
    label: 'Language model',
    category: 'llm',
    why: 'Decides what the assistant says and does.',
    guide: {
      provider: 'openrouter',
      url: 'https://openrouter.ai/settings/keys',
      steps: [
        'Sign up at openrouter.ai and buy a little credit (Settings → Credits).',
        'Settings → API Keys → Create Key. Copy the key, or use Connect with OpenRouter in the dialog.',
        'Paste it here. Empty model fields use the defaults.',
      ],
      cost: 'About $0.003 per call minute with the default models.',
    },
  },
  {
    id: 'tts',
    label: 'Voice',
    category: 'tts',
    why: 'Speaks the assistant’s answers.',
    guide: {
      provider: 'elevenlabs',
      url: 'https://elevenlabs.io/app/developers/api-keys',
      steps: [
        'Sign up at elevenlabs.io.',
        'Developers → API Keys → Create Key. A restricted key needs Text to Speech, Voices (read) and User (read).',
        'Paste it here. Leave the voice empty for the default; each assistant can pick its own.',
      ],
      cost: 'About $0.02 per call minute at list price.',
    },
  },
  {
    id: 'livekit',
    label: 'LiveKit and SIP',
    category: null,
    why: 'Carries the call audio between the carrier, the browser and the voice agent.',
    guide: {
      provider: null,
      url: 'https://docs.livekit.io/home/self-hosting/ports-firewall/',
      steps: [
        'docker compose up starts LiveKit and its SIP bridge; scripts/setup.sh puts their keys in .env.',
        'Open the SIP port (5060) and LiveKit’s audio ports in your firewall, so carriers reach this server.',
        'Once a number is connected: docker compose exec agent node apps/agent/src/setup-sip.ts <number> (with pnpm: pnpm --filter @linedesk/agent setup-sip <number>).',
      ],
      cost: 'Nothing extra: it runs on this server.',
    },
  },
]

export const setupItemSpec = (id: SetupItemId) => setupItems.find(item => item.id === id)!

/** The state of an item from whether its keys are there and the last test of exactly these keys (null: none yet). */
export function setupItemState(setUp: boolean, lastTest: { ok: boolean } | null): SetupItemState {
  if (!setUp) return 'missing'
  if (!lastTest) return 'set_up'
  return lastTest.ok ? 'ok' : 'failing'
}

export type SetupChecklistItem = {
  id: SetupItemId
  label: string
  state: SetupItemState
  /** The provider in use (or the one the item waits for), null when none. */
  provider: ProviderName | null
  providerLabel: string | null
  /** A test result or why it is not ready; never a key. */
  message: string | null
  /** Speech, model and voice when a realtime model answers calls in their place. */
  coveredBy: ProviderName | null
  testedAt: string | null
}
export type SetupChecklist = { items: SetupChecklistItem[]; ready: number; complete: boolean }

export const checklistSummary = (items: readonly Pick<SetupChecklistItem, 'state'>[]) => {
  const ready = items.filter(item => item.state === 'ok').length
  return { ready, complete: ready === items.length }
}

/**
 * One key for speech, model and voice. OpenAI is the only provider in the registry that covers all three: its
 * realtime model hears, thinks and speaks in one, and the agent answers calls with it (apps/agent/src/config.ts).
 * OpenAI has no text-to-speech provider in the registry, so the key cannot fill the three separate stages; speech
 * to text and the language model use the same stored key where those are empty, so a voice is all that is missing
 * to go back to them. The action is `provider.connectOneKey` (admin.ts): tested first, stored only when it works.
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
