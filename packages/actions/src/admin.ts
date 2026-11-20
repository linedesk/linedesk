// The admin area: actions for the operator of the install. All need `instance:admin`, which no
// workspace role has. They change tables that are not synced, so none has a `patch`.
import { type MessageKey, msg } from '@linedesk/i18n'
import { z } from 'zod'
import { isRecordingPrefix } from './calls.ts'
import { defineAction } from './define.ts'
import { type MembershipRole, membershipRoles } from './membership.ts'
import type { ProviderCheckStatus, ProviderFailureReason } from './provider-health.ts'
import { SUMMARY_MODEL_DEFAULTS } from './usage-level.ts'
import { english, type Words } from './words.ts'

export type ProviderCategory =
  | 'telephony'
  | 'stt'
  | 'llm'
  | 'tts'
  | 'realtime'
  | 'email'
  | 'sign_in'
  | 'recording'
  | 'transcript'
  | 'business'
  | 'billing'
  | 'apps'
  | 'bot_check'
  | 'domains'
export const providerCategoryKeys: Record<ProviderCategory, MessageKey> = {
  telephony: msg('admin.provider.category.telephony'),
  stt: msg('admin.provider.category.stt'),
  llm: msg('admin.provider.category.llm'),
  tts: msg('admin.provider.category.tts'),
  realtime: msg('admin.provider.category.realtime'),
  email: msg('admin.provider.category.email'),
  sign_in: msg('admin.provider.category.signIn'),
  recording: msg('admin.provider.category.recording'),
  transcript: msg('admin.provider.category.transcript'),
  business: msg('admin.provider.category.business'),
  billing: msg('admin.provider.category.billing'),
  apps: msg('admin.provider.category.apps'),
  bot_check: msg('admin.provider.category.botCheck'),
  domains: msg('admin.provider.category.domains'),
}
/** A category's name ("Speech to text") in the reader's words; English for the setup MCP and the CLI. */
export const providerCategoryLabel = (category: ProviderCategory, words: Words = english) =>
  words.t(providerCategoryKeys[category])

/** Categories where every provider that is set up is in use at once (no pick): sign-in with Google and GitHub, say. */
export const multiCategories: readonly ProviderCategory[] = ['sign_in', 'apps']
export const isMultiCategory = (category: ProviderCategory) => multiCategories.includes(category)

/**
 * Categories the API reads once at start (Better Auth's sign-in providers): a change there restarts the API, which
 * takes a few seconds (instance-env.ts). The others apply at once, email too (the API follows its stored settings).
 */
export const restartCategories: readonly ProviderCategory[] = ['sign_in']
/**
 * Categories whose settings decide how people sign in or get sign-in codes: whoever controls them can sign in as
 * anyone, so a change needs the passkey step-up (admin-step-up.ts) and every instance admin is told (admin-alerts.ts).
 */
export const signInCategories: readonly ProviderCategory[] = ['email', 'sign_in', 'bot_check']
/**
 * Categories whose keys control money: whoever holds the Stripe key controls charges, refunds and customers.
 * A change needs the passkey session like every Server admin action, and every instance admin
 * is told (admin-alerts.ts), as for sign-in.
 */
export const moneyCategories: readonly ProviderCategory[] = ['billing']
/** A change of these categories' keys emails every instance admin. */
export const alertedCategories: readonly ProviderCategory[] = [...signInCategories, ...moneyCategories]
/** The variable that picks a category's provider when none is picked in the admin area. */
export const categoryEnv: Partial<Record<ProviderCategory, string>> = {
  telephony: 'TELEPHONY_PROVIDER',
  stt: 'STT_PROVIDER',
  llm: 'LLM_PROVIDER',
  tts: 'TTS_PROVIDER',
  email: 'EMAIL_PROVIDER',
  recording: 'RECORDING_STORE',
}
export const categoryNames = Object.keys(providerCategoryKeys) as [ProviderCategory, ...ProviderCategory[]]

/**
 * `env` is the variable used when nothing is stored in the app. `optional` fields are not needed for a
 * connection. `hint` says what an empty field means (shown in the empty input). `switch` fields hold
 * "true" or "false" and show as a checkbox. `phone` fields hold a phone number and show as the phone field
 * (country picker, value in E.164). The label is English written here (`label`), or a key in admin.json (`labelKey`,
 * the newer providers) read in the reader's words where it is shown (providerFieldLabel; docs/translations.md,
 * "Server-side text").
 */
type ProviderField = ({ label: string } | { labelKey: MessageKey }) & {
  env: string
  secret: boolean
  optional?: true
  hint?: string
  switch?: true
  phone?: true
}
/** Values the edit form can fill in for a known service (`<...>` parts are the operator's to replace). */
export type ProviderPreset = { label: string; values: Record<string, string>; help: string }
/**
 * How to get the keys: where to sign up (`url`, null where there is no one place), the steps, and a rough cost
 * ("about", list prices, no promises). Shown in the provider's dialog, the setup MCP and `scripts/setup.sh --check`.
 */
export type ProviderGuide = { url: string | null; steps: readonly string[]; cost: string }
/** A guide whose words are keys in admin.json (the newer providers): providerGuide renders it for the reader. */
type ProviderGuideKeys = { url: string | null; stepKeys: readonly MessageKey[]; costKey: MessageKey }
/**
 * `privacyKey` (a key in admin.json): the step that keeps the provider from training on calls where only the account
 * can say so (a dashboard setting, or a paid plan). providerGuide puts it before the last step (pasting the key).
 */
type GuideSource = (ProviderGuide | ProviderGuideKeys) & { privacyKey?: MessageKey }
/** `help` (or `helpKey`, a key in admin.json) is shown on the provider's card. */
type ProviderSpec = {
  label: string
  category: ProviderCategory
  fields: Record<string, ProviderField>
  guide: GuideSource
  help?: string
  helpKey?: MessageKey
  presets?: readonly ProviderPreset[]
}

const openAiSteps = (rest: string) => [
  'Sign up at platform.openai.com and add credit (Settings → Billing).',
  'API keys → Create new secret key. Copy the key.',
  rest,
]
const llmPaste = 'Paste it here. The models come from Call quality on the Providers page.'
const voicePaste = 'Paste it here. Each assistant picks its own voice.'

/** Every provider's guide (ProviderGuide, or ProviderGuideKeys for the newer ones), keyed like `providers` below. */
const guides = {
  telnyx: {
    url: 'https://portal.telnyx.com/',
    steps: [
      'Create an account at telnyx.com and add a payment method (numbers need a verified account).',
      'Mission Control → Keys & Credentials → API Keys → Create API Key. Copy the key, it is shown once.',
      'Same page, Public Key: copy it. Linedesk checks the signature of Telnyx’s webhooks with it.',
      'Paste both here. The number itself is bought or connected later, in the business onboarding.',
    ],
    cost: 'About $1 a month per US number, plus about $0.005 per call minute.',
  },
  twilio: {
    url: 'https://console.twilio.com/',
    steps: [
      'Create an account at twilio.com and upgrade it (a trial account cannot buy numbers for others).',
      'Console → Account Info: copy the Account SID and the Auth token.',
      'Paste both here. The number itself is bought or connected later, in the business onboarding.',
    ],
    cost: 'About $1.15 a month per US number, plus about $0.01 per call minute.',
  },
  deepgram: {
    url: 'https://console.deepgram.com/',
    steps: [
      'Sign up at console.deepgram.com.',
      'API Keys → Create a New API Key, role Member. Copy the key.',
      'Paste it here. Leave the model empty for the default.',
    ],
    cost: 'About $0.008 per call minute; new accounts start with free credit.',
  },
  elevenlabs_stt: {
    privacyKey: msg('admin.provider.guide.privacy.elevenlabs'),
    url: 'https://elevenlabs.io/app/developers/api-keys',
    steps: [
      'Sign up at elevenlabs.io.',
      'Developers → API Keys → Create Key with Speech to Text access. Copy the key.',
      'Paste it here. Leave the model empty for the default.',
    ],
    cost: 'Billed per hour of audio on your ElevenLabs plan.',
  },
  openai_stt: {
    url: 'https://platform.openai.com/api-keys',
    steps: openAiSteps('Paste it here. Leave the model empty for the default.'),
    cost: 'About $0.003 per call minute with gpt-4o-mini-transcribe.',
  },
  assemblyai_stt: {
    privacyKey: msg('admin.provider.guide.privacy.assemblyai'),
    url: 'https://www.assemblyai.com/dashboard/api-keys',
    stepKeys: [
      msg('admin.provider.guide.assemblyai_stt.step1'),
      msg('admin.provider.guide.assemblyai_stt.step2'),
      msg('admin.provider.guide.assemblyai_stt.step3'),
    ],
    costKey: msg('admin.provider.guide.assemblyai_stt.cost'),
  },
  // After-call transcription (apps/api/src/after-call-transcript.ts): the recording file goes to the provider.
  openai_transcript: {
    url: 'https://platform.openai.com/api-keys',
    steps: openAiSteps('Paste it here, or use the key already saved for OpenAI as language model or realtime model.'),
    cost: 'About $0.0045 per call minute with gpt-transcribe.',
  },
  deepgram_transcript: {
    url: 'https://console.deepgram.com/',
    steps: [
      'Sign up at console.deepgram.com.',
      'API Keys → Create a New API Key, role Member. Copy the key.',
      'Paste it here, or use the key already saved for Deepgram as speech to text.',
    ],
    cost: 'About $0.0043 per call minute with Nova-3 for recorded audio.',
  },
  assemblyai: {
    privacyKey: msg('admin.provider.guide.privacy.assemblyai'),
    url: 'https://www.assemblyai.com/dashboard/api-keys',
    steps: [
      'Sign up at assemblyai.com and add a payment method.',
      'Dashboard → API Keys: copy the key.',
      'Paste it here.',
    ],
    cost: 'About $0.0025 to $0.0035 per call minute with Universal, speaker labels included.',
  },
  elevenlabs_transcript: {
    privacyKey: msg('admin.provider.guide.privacy.elevenlabs'),
    url: 'https://elevenlabs.io/app/developers/api-keys',
    steps: [
      'Sign up at elevenlabs.io.',
      'Developers → API Keys → Create Key with Speech to Text access. Copy the key.',
      'Paste it here, or use the key already saved for ElevenLabs.',
    ],
    cost: 'Billed per hour of audio on your ElevenLabs plan.',
  },
  openrouter: {
    privacyKey: msg('admin.provider.guide.privacy.openrouter'),
    url: 'https://openrouter.ai/settings/keys',
    steps: [
      'Sign up at openrouter.ai and buy a little credit (Settings → Credits).',
      'Settings → API Keys → Create Key. Copy the key, or use Connect with OpenRouter.',
      llmPaste,
    ],
    cost: 'About $0.003 per call minute with the default models.',
  },
  openai: {
    url: 'https://platform.openai.com/api-keys',
    steps: openAiSteps(llmPaste),
    cost: 'Billed per token at OpenAI’s list prices.',
  },
  anthropic: {
    url: 'https://console.anthropic.com/settings/keys',
    steps: [
      'Sign up at console.anthropic.com and add credit (Settings → Billing).',
      'Settings → API keys → Create Key. Copy the key.',
      llmPaste,
    ],
    cost: 'Billed per token at Anthropic’s list prices.',
  },
  gemini: {
    privacyKey: msg('admin.provider.guide.privacy.gemini'),
    url: 'https://aistudio.google.com/apikey',
    steps: [
      'Sign in at aistudio.google.com with a Google account.',
      'Get API key → Create API key. Copy the key.',
      llmPaste,
    ],
    cost: 'A free tier with limits, then billed per token.',
  },
  groq: {
    url: 'https://console.groq.com/keys',
    steps: ['Sign up at console.groq.com.', 'API Keys → Create API Key. Copy the key.', llmPaste],
    cost: 'A free tier with rate limits, then billed per token.',
  },
  mistral: {
    privacyKey: msg('admin.provider.guide.privacy.mistral'),
    url: 'https://console.mistral.ai/api-keys',
    steps: [
      'Sign up at console.mistral.ai and choose a plan (Billing).',
      'API Keys → Create new key. Copy the key.',
      llmPaste,
    ],
    cost: 'Billed per token at Mistral’s list prices.',
  },
  elevenlabs: {
    privacyKey: msg('admin.provider.guide.privacy.elevenlabs'),
    url: 'https://elevenlabs.io/app/developers/api-keys',
    steps: [
      'Sign up at elevenlabs.io.',
      'Developers → API Keys → Create Key. A restricted key needs Text to Speech, Voices (read) and User (read).',
      voicePaste,
    ],
    cost: 'About $0.02 per call minute at list price.',
  },
  cartesia: {
    url: 'https://play.cartesia.ai/keys',
    steps: ['Sign up at play.cartesia.ai.', 'API Keys → New. Copy the key.', voicePaste],
    cost: 'Billed per character on your Cartesia plan.',
  },
  openai_realtime: {
    url: 'https://platform.openai.com/api-keys',
    steps: openAiSteps('Paste it here.'),
    cost: 'About $0.05 per call minute with gpt-realtime-mini.',
  },
  file: {
    url: null,
    steps: [
      'Nothing to sign up for: recordings stay on this server’s disk.',
      'Connect it, then Record here.',
      'Back up the recordings folder with the rest of the server.',
    ],
    cost: 'Nothing extra: disk space on this server.',
  },
  s3: {
    url: null,
    steps: [
      'Create a bucket at your storage provider (AWS S3, Cloudflare R2, Hetzner, Backblaze B2 or MinIO).',
      'Create an access key that can read and write that bucket.',
      'Pick the service here, then fill in the endpoint, the bucket and both keys.',
    ],
    cost: 'Your storage provider’s price per GB stored.',
  },
  smtp: {
    url: null,
    steps: [
      'Get the host, port, user and password of your mail server or service.',
      'Write them as one URL: smtps://user:password@host:465 (port 587: smtp://user:password@host:587).',
      'Paste it here, with a From address the server may send as.',
    ],
    cost: 'Your mail service’s price.',
  },
  resend: {
    url: 'https://resend.com/api-keys',
    steps: [
      'Sign up at resend.com.',
      'Domains → Add Domain. Add the DNS records it shows and wait until it says Verified.',
      'API Keys → Create API Key, permission Sending access, domain All domains. Copy the key.',
      'Paste it here. From is an address on the verified domain, e.g. desk@yourdomain.com.',
    ],
    cost: 'Free up to about 3,000 emails a month.',
  },
  postmark: {
    url: 'https://account.postmarkapp.com/servers',
    steps: [
      'Sign up at postmarkapp.com and verify a sender signature or domain.',
      'Servers → your server → API Tokens. Copy the Server API token.',
      'Paste it here, with a verified From address.',
    ],
    cost: 'A small free allowance, then billed per email.',
  },
  sendgrid: {
    url: 'https://app.sendgrid.com/settings/api_keys',
    steps: [
      'Sign up at sendgrid.com and verify a sender (Settings → Sender Authentication).',
      'Settings → API Keys → Create API Key with Mail Send access. Copy the key.',
      'Paste it here, with the verified From address.',
    ],
    cost: 'Billed on your SendGrid plan.',
  },
  brevo: {
    url: 'https://app.brevo.com/settings/keys/smtp',
    steps: [
      'Sign up at brevo.com and verify your sender domain.',
      'SMTP & API → SMTP: copy the SMTP login and generate an SMTP key.',
      'Paste both here, with a From address on the verified domain.',
    ],
    cost: 'A free daily allowance, then billed on your Brevo plan.',
  },
  mailgun: {
    url: 'https://app.mailgun.com/',
    steps: [
      'Sign up at mailgun.com and add a sending domain with its DNS records.',
      'Sending → Domain settings → SMTP credentials: create a user and copy its password.',
      'Paste both here. Region: eu for a domain in Mailgun’s EU region.',
    ],
    cost: 'Billed on your Mailgun plan.',
  },
  gmail: {
    url: 'https://myaccount.google.com/apppasswords',
    steps: [
      'Turn on 2-Step Verification for the Google account.',
      'Google account → Security → App passwords: create one. Copy it.',
      'Paste the address and the app password here.',
    ],
    cost: 'Free; a few hundred emails a day at most.',
  },
  google: {
    url: 'https://console.cloud.google.com/apis/credentials',
    steps: [
      'In Google Cloud, create a project and set up the OAuth consent screen.',
      'Credentials → Create credentials → OAuth client ID (Web application), with the redirect URIs shown below.',
      'Paste the client ID and the client secret here.',
    ],
    cost: 'Free.',
  },
  microsoft: {
    url: 'https://entra.microsoft.com/',
    steps: [
      'In Microsoft Entra, App registrations → New registration (Web), with the redirect URIs shown below.',
      'API permissions: Calendars.ReadWrite, Mail.Read, offline_access and User.Read. Certificates & secrets → New client secret.',
      'Paste the application ID and the secret here.',
    ],
    cost: 'Free.',
  },
  google_mail: {
    url: 'https://console.cloud.google.com/apis/credentials',
    stepKeys: [
      msg('admin.provider.guide.google_mail.step1'),
      msg('admin.provider.guide.google_mail.step2'),
      msg('admin.provider.guide.google_mail.step3'),
      msg('admin.provider.guide.google_mail.step4'),
    ],
    costKey: msg('admin.provider.guide.google_mail.cost'),
  },
  calendly: {
    url: 'https://calendly.com/app/developer',
    steps: [
      'Sign in to Calendly (any plan) and open Profile menu → Developer → OAuth apps → Create OAuth app.',
      'Environment Production (Sandbox for a test install on localhost), and exactly one redirect URI: the calendar one shown below.',
      'Scopes: users:read, event_types:read and scheduled_events:write.',
      'Copy the client ID and the client secret right away (Calendly shows them once) and paste them here.',
    ],
    cost: 'Free. Each business that books through it may need a paid Calendly plan.',
  },
  calcom: {
    url: 'https://app.cal.com/settings/developer/oauth',
    steps: [
      'Sign in to Cal.com and open Settings → Developer → OAuth → New OAuth client.',
      'Redirect URI: the calendar one shown below (up to 10 per client, so staging and production can share one).',
      'Scopes: PROFILE_READ, EVENT_TYPE_READ, BOOKING_READ and BOOKING_WRITE.',
      'Cal.com reviews the client before it works for others (you get an email). Then paste the client ID and the secret here.',
    ],
    cost: 'Free. Cal.com cloud only (cal.com), not a self-hosted Cal.com.',
  },
  github: {
    url: 'https://github.com/settings/developers',
    steps: [
      'GitHub → Settings → Developer settings → OAuth Apps → New OAuth App, with the callback URL shown below.',
      'Generate a client secret.',
      'Paste the client ID and the client secret here.',
    ],
    cost: 'Free.',
  },
  oidc: {
    url: null,
    steps: [
      'In your identity provider (Okta, Entra, Keycloak, Authentik …), create an OpenID Connect web app with the redirect URI shown below.',
      'Copy its discovery URL, client ID and client secret.',
      'Paste them here. Add trusted email domains if it sends no email_verified.',
    ],
    cost: 'Your identity provider’s price.',
  },
  google_places: {
    url: 'https://console.cloud.google.com/apis/library/places.googleapis.com',
    steps: [
      'In Google Cloud, enable the Places API (New) for a project with billing.',
      'Credentials → Create credentials → API key; restrict it to the Places API (New).',
      'Paste it here.',
    ],
    cost: 'Billed per search and per picked listing at Google’s prices.',
  },
  stripe: {
    url: 'https://dashboard.stripe.com/apikeys',
    steps: [
      'In the Stripe Dashboard, Developers → API keys → Create restricted key with write on Customers, Checkout Sessions, Subscriptions, Invoices, Invoice Items, Credit Notes, Refunds, Billing Portal Sessions, the Customer portal, Products and Prices, and read on PaymentMethods, SetupIntents, Charges, Disputes, Radar Early Fraud Warnings, Events and Tax settings. A secret key works too.',
      'Developers → Webhooks → Add endpoint for https://<your server>/v1/billing/stripe/webhook; copy its signing secret (whsec_…).',
      'Paste both here. Use test keys (sk_test_ or rk_test_) until go-live; a dev install refuses live keys.',
    ],
    cost: 'Stripe’s fees per charge, plus Stripe Billing and Stripe Tax.',
  },
  hubspot: {
    url: 'https://developers.hubspot.com/',
    steps: [
      'HubSpot makes apps only from a project uploaded with the HubSpot CLI (npm i -g @hubspot/cli; hs account auth with a free developer account).',
      'Use the project in integrations/hubspot of the Linedesk repo: add the redirect URL shown below to redirectUrls in src/app/app-hsmeta.json, then hs project upload.',
      'In HubSpot, Development › Projects › your project › the app › Auth: copy the client ID and the client secret and paste them here.',
    ],
    cost: 'Free. Each business connects its own HubSpot, on any HubSpot plan.',
  },
  slack: {
    url: 'https://api.slack.com/apps',
    stepKeys: [
      msg('admin.provider.guide.slack.step1'),
      msg('admin.provider.guide.slack.step2'),
      msg('admin.provider.guide.slack.step3'),
      msg('admin.provider.guide.slack.step4'),
    ],
    costKey: msg('admin.provider.guide.slack.cost'),
  },
  jobber: {
    url: 'https://developer.getjobber.com/',
    stepKeys: [
      msg('admin.provider.guide.jobber.step1'),
      msg('admin.provider.guide.jobber.step2'),
      msg('admin.provider.guide.jobber.step3'),
    ],
    costKey: msg('admin.provider.guide.jobber.cost'),
  },
  turnstile: {
    url: 'https://dash.cloudflare.com/?to=/:account/turnstile',
    steps: [
      'In the Cloudflare dashboard, Turnstile → Add widget, for the address people open the app at (Managed mode).',
      'Copy its site key and its secret key.',
      'Paste both here. The sign-up page shows the check; the server verifies it before a sign-up code is sent.',
    ],
    cost: 'Free.',
  },
  cloudflare_saas: {
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    stepKeys: [
      msg('admin.provider.guide.cloudflare_saas.step1'),
      msg('admin.provider.guide.cloudflare_saas.step2'),
      msg('admin.provider.guide.cloudflare_saas.step3'),
      msg('admin.provider.guide.cloudflare_saas.step4'),
    ],
    costKey: msg('admin.provider.guide.cloudflare_saas.cost'),
  },
} as const satisfies Record<string, GuideSource>

/**
 * The provider we suggest per category: a quiet "Recommended" tag on Server admin › Providers, and the guide the setup MCP
 * and `setup.sh --check` print first.
 */
export const recommendedProviders: Record<ProviderCategory, ProviderName> = {
  telephony: 'telnyx',
  stt: 'deepgram',
  llm: 'openai',
  tts: 'elevenlabs',
  realtime: 'openai_realtime',
  email: 'resend',
  sign_in: 'google',
  recording: 'file',
  transcript: 'elevenlabs_transcript',
  business: 'google_places',
  billing: 'stripe',
  apps: 'hubspot',
  bot_check: 'turnstile',
  domains: 'cloudflare_saas',
}

/**
 * The short list of a category with many providers, in this order: the recommended one first, then the others most
 * people pick. Server admin › Providers and the install walkthrough show only these (and every provider that is already set
 * up, being tested or failing) until "Show more". A category with more than three providers and no entry here shows
 * its recommended one and its own-server option (SMTP, your own single sign-on), see `pinnedProvidersOf`.
 */
export const pinnedProviders: Partial<Record<ProviderCategory, readonly ProviderName[]>> = {
  email: ['resend', 'smtp'],
  llm: ['openai', 'openrouter', 'anthropic'],
  sign_in: ['google', 'oidc'],
  stt: ['deepgram', 'assemblyai_stt'],
}

/** The option that runs on your own server or account rather than a hosted service. */
export const ownServerProviders: readonly ProviderName[] = ['smtp', 'oidc']

/** A category's short list: its pinned providers, or else its recommended one and its own-server option. */
export function pinnedProvidersOf(category: ProviderCategory): readonly ProviderName[] {
  const pinned = pinnedProviders[category]
  if (pinned) return pinned
  const own = providersIn(category).filter(p => ownServerProviders.includes(p))
  return [recommendedProviders[category], ...own]
}

const apiKey = (env: string): ProviderField => ({ label: 'API key', env, secret: true })
/**
 * The number forwarding checks call businesses from (apps/api/src/forwarding-check.ts). A number in this account
 * that no workspace uses; empty: the first such number in the account.
 */
const checkNumber = (env: string): ProviderField => ({
  label: 'Forwarding check number',
  env,
  secret: false,
  optional: true,
  hint: 'any unused number in this account',
  phone: true,
})
const FORWARDING_CHECK_HELP =
  'Forwarding checks call a business from the forwarding check number, a number in this account that no workspace uses (a few cents a check). Empty: the first such number in the account.'
/**
 * Where each language-model provider answers (OpenAI-compatible chat completions) and its default models: `models`
 * for live turns (first one first, then fallbacks; a call uses its level's model first), `summaryModels` for the summary
 * and other background work (SUMMARY_MODEL_DEFAULTS, usage-level.ts, next to the level defaults).
 * Live turns need the fastest first token (Gemini Flash-Lite about 0.6 s from the server on 2.5, gpt-5.4-mini about
 * 1.05 s); the summary is not latency-critical. Every default is a Standard model (usage-level.ts). Gemini 2.5 Flash
 * and Flash-Lite are deprecated (2.5 Flash routes to 3.5 Flash-Lite from 2026-12-01), so Gemini defaults to 3.5
 * Flash-Lite, Google's successor, for both. Used by the agent and the API alike.
 */
export const llmEndpoints = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['google/gemini-3.5-flash-lite', 'openai/gpt-4.1-mini'],
    summaryModels: SUMMARY_MODEL_DEFAULTS.openrouter,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1-mini'],
    summaryModels: SUMMARY_MODEL_DEFAULTS.openai,
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-haiku-5-5'],
    summaryModels: SUMMARY_MODEL_DEFAULTS.anthropic,
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.5-flash-lite'],
    summaryModels: SUMMARY_MODEL_DEFAULTS.gemini,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile'],
    summaryModels: SUMMARY_MODEL_DEFAULTS.groq,
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
    summaryModels: SUMMARY_MODEL_DEFAULTS.mistral,
  },
} as const satisfies Record<string, { baseUrl: string; models: readonly string[]; summaryModels: readonly string[] }>
export type LlmProvider = keyof typeof llmEndpoints

/**
 * OpenRouter's provider routing for call data (https://openrouter.ai/docs/guides/routing/provider-selection):
 * `data_collection: 'deny'` sends a request only to providers that don't train on it, and `zdr: true` only to
 * endpoints with zero data retention (https://openrouter.ai/docs/guides/features/zdr: no storage after the answer,
 * so no training either). ZDR is on unless the instance admin turned it off (the OpenRouter provider's
 * `zero_data_retention` switch); no training is always on. A model no endpoint serves this way answers 404.
 */
export const openRouterPrivacy = (zeroDataRetention: boolean) =>
  ({
    provider: zeroDataRetention ? { data_collection: 'deny', zdr: true } : { data_collection: 'deny' },
  }) as const
/** Whether a chat completions base URL is OpenRouter's; other APIs would refuse OpenRouter's `provider` field. */
export const isOpenRouterUrl = (baseUrl: string) => /^https:\/\/openrouter\.ai\//.test(baseUrl)
/**
 * What every request to a language model carries so no provider trains on call data or keeps it: OpenRouter's routing
 * rule (openRouterPrivacy); nothing for the other APIs (they don't train on API data, or not on paid keys).
 */
export const noTrainingFields = (baseUrl: string, zeroDataRetention = true) =>
  isOpenRouterUrl(baseUrl) ? openRouterPrivacy(zeroDataRetention) : {}
/** The OpenRouter `zero_data_retention` switch's stored value: on unless it says "false" (empty: the default, on). */
export const zeroDataRetentionOn = (value: string | null | undefined) => value?.trim() !== 'false'
/**
 * The clear error when OpenRouter has no endpoint for a model under openRouterPrivacy (a 404 "No endpoints found
 * ..."), naming the model and the fix, in the reader's words (English for logs); null for any other answer. Logged by
 * the agent and the API, shown by the provider test.
 */
export function noPrivateEndpointText(
  status: number,
  body: string,
  baseUrl: string,
  model: string,
  zeroDataRetention: boolean,
  words: Words = english,
): string | null {
  // "No endpoints found matching your data policy (...)": not other 404s (an unknown model, unsupported parameters).
  const refused = /no endpoints? (found|available)\b.*\b(data|retention|zdr|privacy|polic)/i.test(body)
  if (!isOpenRouterUrl(baseUrl) || status !== 404 || !refused) return null
  return words.t(
    zeroDataRetention
      ? msg('admin.provider.openrouter.noZdrEndpoint')
      : msg('admin.provider.openrouter.noPrivateEndpoint'),
    { model },
  )
}

/**
 * A language-model provider's fields: its key only (decision of 2026-11-18). The live model is per call quality level
 * (Server admin › Providers › Call quality), the summary model the provider's default (llmEndpoints).
 */
const llmFields = (keyEnv: string): Record<string, ProviderField> => ({ api_key: apiKey(keyEnv) })

/** Every mail service's sender. Empty: the service's default (Gmail: its address), else "Linedesk <no-reply@localhost>". */
const emailFrom: ProviderField = {
  label: 'From',
  env: 'EMAIL_FROM',
  secret: false,
  optional: true,
  hint: 'no-reply@example.com, or Name <no-reply@example.com>',
}

/**
 * The providers an instance admin can set up. To add one: an entry here, and how to test its
 * connection in apps/api/src/provider-test.ts. The database stores provider id and field name as
 * text, so a new provider needs no migration. Env names follow the voice agent's (apps/agent/src/config.ts).
 */
export const providers = {
  telnyx: {
    label: 'Telnyx',
    category: 'telephony',
    guide: guides.telnyx,
    fields: {
      api_key: apiKey('TELNYX_API_KEY'),
      public_key: { label: 'Webhook public key', env: 'TELNYX_PUBLIC_KEY', secret: false, optional: true },
      check_number: checkNumber('TELNYX_CHECK_NUMBER'),
    },
    help: FORWARDING_CHECK_HELP,
  },
  twilio: {
    label: 'Twilio',
    category: 'telephony',
    guide: guides.twilio,
    fields: {
      account_sid: { label: 'Account SID', env: 'TWILIO_ACCOUNT_SID', secret: false },
      auth_token: { label: 'Auth token', env: 'TWILIO_AUTH_TOKEN', secret: true },
      check_number: checkNumber('TWILIO_CHECK_NUMBER'),
    },
    help: FORWARDING_CHECK_HELP,
  },
  deepgram: {
    label: 'Deepgram',
    category: 'stt',
    guide: guides.deepgram,
    fields: { api_key: apiKey('DEEPGRAM_API_KEY') },
  },
  // Streaming speech recognition with the provider's own end-of-turn detection. Own key variables: a key for the voice
  // or the language model in the environment must not switch speech recognition over.
  elevenlabs_stt: {
    label: 'ElevenLabs Scribe',
    category: 'stt',
    guide: guides.elevenlabs_stt,
    fields: { api_key: apiKey('ELEVENLABS_STT_API_KEY') },
  },
  openai_stt: {
    label: 'OpenAI transcription',
    category: 'stt',
    guide: guides.openai_stt,
    fields: { api_key: apiKey('OPENAI_STT_API_KEY') },
  },
  assemblyai_stt: {
    label: 'AssemblyAI',
    category: 'stt',
    guide: guides.assemblyai_stt,
    fields: {
      api_key: apiKey('ASSEMBLYAI_STT_API_KEY'),
      // On unless "false" (as every switch): `max_accuracy` ends a turn as late as Deepgram Flux; off, `balanced` ends
      // it sooner but cuts callers off at a short pause (LIN-516).
      wait_for_caller: {
        labelKey: msg('admin.provider.field.waitForCaller'),
        env: 'ASSEMBLYAI_STT_WAIT_FOR_CALLER',
        secret: false,
        optional: true,
        switch: true,
      },
    },
    helpKey: msg('admin.provider.help.assemblyai_stt'),
  },
  // After-call transcription: the recording is uploaded after the call and the caller's lines are corrected. Never
  // picked on its own: only an instance admin's choice turns it on (no first-set-up fallback, like recording storage).
  openai_transcript: {
    label: 'OpenAI',
    category: 'transcript',
    guide: guides.openai_transcript,
    fields: { api_key: apiKey('TRANSCRIPT_OPENAI_API_KEY') },
    help: 'Each call’s recording file is uploaded to OpenAI after the call. gpt-transcribe: plain text, matched to the call by the assistant’s own lines.',
  },
  deepgram_transcript: {
    label: 'Deepgram',
    category: 'transcript',
    guide: guides.deepgram_transcript,
    fields: { api_key: apiKey('TRANSCRIPT_DEEPGRAM_API_KEY') },
    help: 'Each call’s recording file is uploaded to Deepgram after the call. Nova-3 for recorded audio, with speaker labels and times.',
  },
  assemblyai: {
    label: 'AssemblyAI',
    category: 'transcript',
    guide: guides.assemblyai,
    fields: { api_key: apiKey('ASSEMBLYAI_API_KEY') },
    help: 'Each call’s recording file is uploaded to AssemblyAI after the call; its transcript there is deleted once read. Universal, with speaker labels and times.',
  },
  elevenlabs_transcript: {
    label: 'ElevenLabs Scribe',
    category: 'transcript',
    guide: guides.elevenlabs_transcript,
    fields: { api_key: apiKey('TRANSCRIPT_ELEVENLABS_API_KEY') },
    help: 'Each call’s recording file is uploaded to ElevenLabs after the call. Scribe v2, with speaker labels and times.',
  },
  // The default language model comes first: a category without a pick uses the first provider that is set up.
  openai: { label: 'OpenAI', category: 'llm', guide: guides.openai, fields: llmFields('OPENAI_API_KEY') },
  openrouter: {
    label: 'OpenRouter',
    category: 'llm',
    guide: guides.openrouter,
    fields: {
      api_key: apiKey('OPENROUTER_API_KEY'),
      // On unless "false" (zeroDataRetentionOn): every request then asks for endpoints that keep nothing.
      zero_data_retention: {
        labelKey: msg('admin.provider.field.zeroDataRetention'),
        env: 'OPENROUTER_ZERO_DATA_RETENTION',
        secret: false,
        optional: true,
        switch: true,
      },
    },
    helpKey: msg('admin.provider.help.openrouter'),
  },
  anthropic: {
    label: 'Anthropic',
    category: 'llm',
    guide: guides.anthropic,
    fields: llmFields('ANTHROPIC_API_KEY'),
  },
  gemini: {
    label: 'Google Gemini',
    category: 'llm',
    guide: guides.gemini,
    fields: llmFields('GEMINI_API_KEY'),
  },
  groq: { label: 'Groq', category: 'llm', guide: guides.groq, fields: llmFields('GROQ_API_KEY') },
  mistral: {
    label: 'Mistral',
    category: 'llm',
    guide: guides.mistral,
    fields: llmFields('MISTRAL_API_KEY'),
  },
  elevenlabs: {
    label: 'ElevenLabs',
    category: 'tts',
    guide: guides.elevenlabs,
    fields: { api_key: apiKey('ELEVENLABS_API_KEY') },
  },
  cartesia: {
    label: 'Cartesia',
    category: 'tts',
    guide: guides.cartesia,
    fields: { api_key: apiKey('CARTESIA_API_KEY') },
  },
  // A speech-to-speech model: hears the caller and answers in its own voice. Once connected, assistants on Ultra
  // answer with it (Call quality on the Providers page). The summary after the call goes to
  // OpenAI's chat API with the same key. Its own key variable: an OPENAI_API_KEY for the language model must not
  // switch calls to realtime.
  openai_realtime: {
    label: 'OpenAI Realtime',
    category: 'realtime',
    guide: guides.openai_realtime,
    fields: {
      api_key: apiKey('OPENAI_REALTIME_API_KEY'),
    },
    help: 'Once connected, it answers calls with one speech-to-speech model in its own voice, instead of speech to text, language model and voice; disconnect it to go back. Warm transfer and the cached greeting are not available then; each assistant picks one of the model’s voices.',
  },
  // Recording storage: where LiveKit egress writes call audio and the API reads it. Not a paid API, but
  // the same model: one active store, keys stored encrypted, env as fallback. No first-set-up fallback:
  // without a pick or RECORDING_STORE, calls are not recorded (apps/api/src/provider-settings.ts).
  file: {
    label: 'Local disk',
    category: 'recording',
    guide: guides.file,
    fields: {},
    help: 'Recordings stay on this server.',
  },
  s3: {
    label: 'S3-compatible',
    category: 'recording',
    guide: guides.s3,
    fields: {
      endpoint: {
        label: 'Endpoint URL',
        env: 'S3_ENDPOINT',
        secret: false,
        hint: 'https://s3.us-east-1.amazonaws.com',
      },
      region: { label: 'Region', env: 'S3_REGION', secret: false, optional: true, hint: 'us-east-1' },
      bucket: { label: 'Bucket', env: 'S3_BUCKET', secret: false },
      access_key_id: { label: 'Access key ID', env: 'S3_ACCESS_KEY_ID', secret: false },
      secret_access_key: { label: 'Secret access key', env: 'S3_SECRET_ACCESS_KEY', secret: true },
      prefix: {
        label: 'Path prefix',
        env: 'S3_PREFIX',
        secret: false,
        optional: true,
        hint: 'Optional',
      },
      force_path_style: {
        label: 'Force path style',
        env: 'S3_FORCE_PATH_STYLE',
        secret: false,
        optional: true,
        switch: true,
      },
    },
    help: 'AWS S3, Cloudflare R2, Hetzner, Backblaze B2, MinIO or any S3-compatible bucket.',
    presets: [
      {
        label: 'AWS S3',
        values: { endpoint: 'https://s3.<region>.amazonaws.com', region: '<region>', force_path_style: 'false' },
        help: 'Replace <region>, e.g. us-east-1.',
      },
      {
        label: 'Cloudflare R2',
        values: { endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto', force_path_style: 'true' },
        help: 'Replace <account-id> with your Cloudflare account ID.',
      },
      {
        label: 'Hetzner',
        values: {
          endpoint: 'https://<location>.your-objectstorage.com',
          region: '<location>',
          force_path_style: 'false',
        },
        help: 'Replace <location>: fsn1, nbg1 or hel1.',
      },
      {
        label: 'Backblaze B2',
        values: { endpoint: 'https://s3.<region>.backblazeb2.com', region: '<region>', force_path_style: 'false' },
        help: 'Replace <region>, e.g. us-west-004.',
      },
      {
        label: 'MinIO',
        values: { endpoint: 'http://<host>:9000', region: 'us-east-1', force_path_style: 'true' },
        help: 'Replace <host> with your MinIO server.',
      },
    ],
  },
  // Email: how sign-in codes, invitations and call emails go out. Without it, email codes are off.
  smtp: {
    label: 'SMTP',
    category: 'email',
    guide: guides.smtp,
    fields: {
      url: {
        label: 'SMTP URL',
        env: 'SMTP_URL',
        secret: true,
        hint: 'smtps://user:password@smtp.example.com:465',
      },
      from: emailFrom,
    },
    help: 'Sends sign-in codes, invitations and call emails through any mail server: Amazon SES, your own server or another service with SMTP.',
    presets: [
      {
        label: 'Amazon SES',
        values: { url: 'smtps://<smtp-user>:<smtp-password>@email-smtp.<region>.amazonaws.com:465' },
        help: 'Use SES SMTP credentials (not your AWS access key) and your region, e.g. us-east-1.',
      },
    ],
  },
  // Mail services with a key or an app password instead of an SMTP URL. The API turns their fields into the connection
  // it sends with (apps/api/src/email-services.ts): SMTP on 587, except Resend, which sends through its HTTPS API (443,
  // open where hosts block SMTP). One of them sends: the one picked, else the first set up.
  resend: {
    label: 'Resend',
    category: 'email',
    guide: guides.resend,
    fields: {
      api_key: apiKey('RESEND_API_KEY'),
      from: emailFrom,
      // White-label partners' own sender domains (S6, apps/api/src/partner-sender.ts): adding, checking and removing a
      // domain needs a full-access key; the sending key above keeps sending access only. Without it, Partner › Email
      // sender is hidden.
      domains_api_key: {
        // i18n-ignore: a field name in the English-only provider registry, like every other field label here
        label: 'Domains API key (partners)',
        env: 'RESEND_DOMAINS_API_KEY',
        secret: true,
        optional: true,
      },
    },
    help: 'An API key with sending access, on all domains. The From address must be on a domain verified in Resend. Optional: a second key with full access lets white-label partners send from their own domains.',
  },
  postmark: {
    label: 'Postmark',
    category: 'email',
    guide: guides.postmark,
    fields: {
      server_token: { label: 'Server API token', env: 'POSTMARK_SERVER_TOKEN', secret: true },
      from: emailFrom,
    },
    help: 'The server API token of a Postmark server. The From address must be a verified sender signature or domain.',
  },
  sendgrid: {
    label: 'SendGrid',
    category: 'email',
    guide: guides.sendgrid,
    fields: { api_key: apiKey('SENDGRID_API_KEY'), from: emailFrom },
    help: 'An API key with Mail Send access. The From address must be a verified sender in SendGrid.',
  },
  brevo: {
    label: 'Brevo',
    category: 'email',
    guide: guides.brevo,
    fields: {
      login: { label: 'SMTP login', env: 'BREVO_SMTP_LOGIN', secret: false, hint: '1234ab001@smtp-brevo.com' },
      smtp_key: { label: 'SMTP key', env: 'BREVO_SMTP_KEY', secret: true },
      from: emailFrom,
    },
    help: 'The SMTP login and an SMTP key from Brevo, SMTP & API (not an API key).',
  },
  mailgun: {
    label: 'Mailgun',
    category: 'email',
    guide: guides.mailgun,
    fields: {
      smtp_user: { label: 'SMTP user', env: 'MAILGUN_SMTP_USER', secret: false, hint: 'postmaster@mg.example.com' },
      smtp_password: { label: 'SMTP password', env: 'MAILGUN_SMTP_PASSWORD', secret: true },
      region: { label: 'Region', env: 'MAILGUN_REGION', secret: false, optional: true, hint: 'us (or eu)' },
      from: emailFrom,
    },
    help: 'The SMTP credentials of a sending domain (Mailgun, Sending, Domain settings, SMTP credentials).',
  },
  gmail: {
    label: 'Gmail',
    category: 'email',
    guide: guides.gmail,
    fields: {
      address: { label: 'Gmail address', env: 'GMAIL_ADDRESS', secret: false, hint: 'desk@gmail.com' },
      app_password: { label: 'App password', env: 'GMAIL_APP_PASSWORD', secret: true },
      from: { ...emailFrom, hint: 'Empty: the Gmail address' },
    },
    help: 'A Gmail or Google Workspace address with 2-Step Verification and an app password (Google account, Security, App passwords). Gmail sends a few hundred emails a day at most: for a small team.',
  },
  // Sign-in and calendar: OAuth apps. Google and Microsoft serve both sign-in and the calendar connection.
  google: {
    label: 'Google',
    category: 'sign_in',
    guide: guides.google,
    fields: {
      client_id: { label: 'Client ID', env: 'GOOGLE_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'GOOGLE_CLIENT_SECRET', secret: true },
    },
    help: 'In Google Cloud, create an OAuth client (Web application) with the redirect URIs below. For calendars the consent screen lists calendar.events, calendar.freebusy and calendar.calendarlist.readonly.',
  },
  microsoft: {
    label: 'Microsoft',
    category: 'sign_in',
    guide: guides.microsoft,
    fields: {
      client_id: { label: 'Application (client) ID', env: 'MICROSOFT_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'MICROSOFT_CLIENT_SECRET', secret: true },
      tenant_id: { label: 'Tenant', env: 'MICROSOFT_TENANT_ID', secret: false, optional: true, hint: 'common' },
    },
    help: 'In Microsoft Entra, register an app (Web) with the redirect URIs below and the delegated permissions Calendars.ReadWrite, Mail.Read (support mailboxes), offline_access and User.Read. Work accounts sign in only with the optional ID-token claims xms_edov and email (Token configuration). Tenant: an ID limits sign-in to one organization.',
  },
  // Calendar apps of scheduling tools: a business connects by consent page. Without one, it pastes a key.
  calendly: {
    label: 'Calendly',
    category: 'sign_in',
    guide: guides.calendly,
    fields: {
      client_id: { label: 'Client ID', env: 'CALENDLY_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'CALENDLY_CLIENT_SECRET', secret: true },
    },
    help: 'An OAuth app in Calendly (Developer → OAuth apps) with the redirect URI below. Businesses then connect Calendly with one click. Without it, they paste a personal access token.',
  },
  calcom: {
    label: 'Cal.com',
    category: 'sign_in',
    guide: guides.calcom,
    fields: {
      client_id: { label: 'Client ID', env: 'CALCOM_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'CALCOM_CLIENT_SECRET', secret: true },
    },
    help: 'An OAuth client in Cal.com (Settings → Developer → OAuth), approved by Cal.com, with the redirect URI below. Businesses then connect Cal.com with one click. Without it, they paste an API key.',
  },
  github: {
    label: 'GitHub',
    category: 'sign_in',
    guide: guides.github,
    fields: {
      client_id: { label: 'Client ID', env: 'GITHUB_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'GITHUB_CLIENT_SECRET', secret: true },
    },
    help: 'Create an OAuth app under GitHub, Developer settings, with the callback URL below. Only the primary email, and only when GitHub verified it, signs anyone in.',
  },
  oidc: {
    label: 'Single sign-on (OIDC)',
    category: 'sign_in',
    guide: guides.oidc,
    fields: {
      discovery_url: {
        label: 'Discovery URL',
        env: 'OIDC_DISCOVERY_URL',
        secret: false,
        hint: 'https://idp.example.com/.well-known/openid-configuration',
      },
      client_id: { label: 'Client ID', env: 'OIDC_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'OIDC_CLIENT_SECRET', secret: true },
      display_name: {
        label: 'Button label',
        env: 'OIDC_DISPLAY_NAME',
        secret: false,
        optional: true,
        hint: 'Single sign-on',
      },
      trust_email_domains: {
        label: 'Trusted email domains',
        env: 'OIDC_TRUST_EMAIL_DOMAINS',
        secret: false,
        optional: true,
        hint: 'example.com (comma-separated; only domains your identity provider owns)',
      },
    },
    help: 'Okta, Microsoft Entra, Keycloak, Authentik or any OpenID Connect provider. It must send email_verified only for verified addresses; for one that sends none, list the email domains it owns.',
  },
  // Business lookup: onboarding finds the business's listing (address, phone, hours, website, category) by name and
  // city. Optional: without it the owner types the name and website. Called only from the API (business.search).
  google_places: {
    label: 'Google Places',
    category: 'business',
    guide: guides.google_places,
    fields: { api_key: apiKey('GOOGLE_PLACES_API_KEY') },
    help: 'An API key with the Places API (New) enabled, restricted to it. Onboarding uses it to find a business by name and city and prefill its address, phone, hours and website. Google bills each search as Text Search Pro and each picked listing as Place Details Enterprise (the hours and the website are in that tier). BUSINESS_LOOKUP_DAILY_CAP limits the requests per day.',
  },
  // Billing: the install bills its own workspaces through its own Stripe account, at the prices
  // set in Server admin › Billing. Without keys, or while billing is off (billingEnabled.set), nothing is billed.
  stripe: {
    label: 'Stripe',
    category: 'billing',
    guide: guides.stripe,
    fields: {
      // `env` is never read for billing keys (provider-settings.ts): they come only from the store.
      secret_key: { label: 'Secret key', env: 'STRIPE_SECRET_KEY', secret: true, hint: 'rk_test_… (a restricted key)' },
      webhook_secret: { label: 'Webhook signing secret', env: 'STRIPE_WEBHOOK_SECRET', secret: true, hint: 'whsec_…' },
      // Rotation: the old secret is accepted beside the new one until it is removed.
      webhook_secret_previous: {
        label: 'Previous webhook signing secret',
        env: 'STRIPE_WEBHOOK_SECRET_PREVIOUS',
        secret: true,
        optional: true,
        hint: 'whsec_… (only while rotating)',
      },
    },
    help: 'A restricted key (rk_…) with only the permissions billing needs, or a secret key (sk_…), and the signing secret of the webhook endpoint. Test keys charge nothing; live keys are refused on a dev install. Billing starts only once it is turned on below; the prices are set under Billing › Prices and rules.',
  },
  // Connected apps (docs/crm-sync.md): a business connects its own account by consent page, and finished calls go there.
  hubspot: {
    label: 'HubSpot',
    category: 'apps',
    guide: guides.hubspot,
    fields: {
      client_id: { label: 'Client ID', env: 'HUBSPOT_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'HUBSPOT_CLIENT_SECRET', secret: true },
    },
    help: 'A HubSpot app with the redirect URL below and the contact scopes. Businesses then connect their HubSpot under Integrations, and every finished phone call goes to the caller’s contact.',
  },
  slack: {
    label: 'Slack',
    category: 'apps',
    guide: guides.slack,
    fields: {
      client_id: { label: 'Client ID', env: 'SLACK_CLIENT_ID', secret: false, hint: '1234567890.1234567890' },
      client_secret: { label: 'Client secret', env: 'SLACK_CLIENT_SECRET', secret: true },
      // Checks the Events API requests (apps/api/src/slack-events.ts): an uninstall in Slack is seen at once.
      signing_secret: {
        labelKey: msg('admin.provider.field.signingSecret'),
        env: 'SLACK_SIGNING_SECRET',
        secret: true,
        optional: true,
      },
    },
    help: 'A Slack app with the redirect URL below and the incoming-webhook scope. Businesses then connect their Slack under Integrations, pick a channel, and every finished phone call is posted there. Slack checks the client secret only when a business connects.',
  },
  jobber: {
    label: 'Jobber',
    category: 'apps',
    guide: guides.jobber,
    fields: {
      client_id: { labelKey: msg('admin.provider.field.clientId'), env: 'JOBBER_CLIENT_ID', secret: false },
      client_secret: { labelKey: msg('admin.provider.field.clientSecret'), env: 'JOBBER_CLIENT_SECRET', secret: true },
    },
    helpKey: msg('admin.provider.help.jobber'),
  },
  // Support mailboxes: Gmail's read-only scope is restricted, so it has an OAuth app of its own, apart from
  // the sign-in and calendar app (`google`), whose verification it would otherwise hold up. Microsoft 365 mailboxes
  // use the `microsoft` app (Mail.Read).
  google_mail: {
    // i18n-ignore: a product name in the English-only provider registry, like every other provider label here
    label: 'Gmail API',
    category: 'apps',
    guide: guides.google_mail,
    fields: {
      client_id: { labelKey: msg('admin.provider.field.clientId'), env: 'GOOGLE_MAIL_CLIENT_ID', secret: false },
      client_secret: {
        labelKey: msg('admin.provider.field.clientSecret'),
        env: 'GOOGLE_MAIL_CLIENT_SECRET',
        secret: true,
      },
    },
    helpKey: msg('admin.provider.help.google_mail'),
  },
  // Self-serve sign-up's bot check: the sign-up page shows the Turnstile widget,
  // and the server checks its answer with the secret before a sign-up code goes out.
  turnstile: {
    label: 'Cloudflare Turnstile',
    category: 'bot_check',
    guide: guides.turnstile,
    fields: {
      site_key: { label: 'Site key', env: 'TURNSTILE_SITE_KEY', secret: false, hint: '0x4AAAA…' },
      secret_key: { label: 'Secret key', env: 'TURNSTILE_SECRET_KEY', secret: true, hint: '0x4AAAA…' },
    },
    help: 'The bot check on the self-serve sign-up page. While self-serve sign-up needs it and it is not set up, sign-up stays closed.',
  },
  // White-label partners' own addresses (S5, apps/api/src/partner-domain.ts): each partner address is a custom
  // hostname in the install's zone. Without it, Partner › Domain is hidden.
  cloudflare_saas: {
    label: 'Cloudflare for SaaS',
    category: 'domains',
    guide: guides.cloudflare_saas,
    fields: {
      api_token: { labelKey: msg('admin.provider.field.apiToken'), env: 'CLOUDFLARE_SAAS_API_TOKEN', secret: true },
      zone_id: { labelKey: msg('admin.provider.field.zoneId'), env: 'CLOUDFLARE_SAAS_ZONE_ID', secret: false },
      cname_target: {
        labelKey: msg('admin.provider.field.cnameTarget'),
        env: 'CLOUDFLARE_SAAS_CNAME_TARGET',
        secret: false,
        hint: 'partners.linedesk.ai',
      },
      custom_origin: {
        labelKey: msg('admin.provider.field.customOrigin'),
        env: 'CLOUDFLARE_SAAS_CUSTOM_ORIGIN',
        secret: false,
        optional: true,
        hint: 'saas-origin.example.com',
      },
    },
    helpKey: msg('admin.provider.help.cloudflare_saas'),
  },
} as const satisfies Record<string, ProviderSpec>

export type ProviderName = keyof typeof providers
export const providerNames = Object.keys(providers) as [ProviderName, ...ProviderName[]]
export const providerSpec = (name: ProviderName): ProviderSpec => providers[name]
/** A provider's key guide in the reader's words (English for the setup MCP and the CLI). */
export function providerGuide(name: ProviderName, words: Words = english): ProviderGuide {
  const guide = providerSpec(name).guide
  const { url, steps, cost } =
    'stepKeys' in guide
      ? { url: guide.url, steps: guide.stepKeys.map(key => words.t(key)), cost: words.t(guide.costKey) }
      : guide
  if (!guide.privacyKey) return { url, steps, cost }
  return { url, steps: [...steps.slice(0, -1), words.t(guide.privacyKey), ...steps.slice(-1)], cost }
}
/** The text on a provider's card, in the reader's words; null when it has none. */
export function providerHelp(name: ProviderName, words: Words = english): string | null {
  const spec = providerSpec(name)
  return spec.helpKey ? words.t(spec.helpKey) : (spec.help ?? null)
}
/** A field's label in the reader's words (`field` is one of the provider's). */
export function providerFieldLabel(name: ProviderName, field: string, words: Words = english): string {
  const spec = providerSpec(name).fields[field]
  if (!spec) return field
  return 'labelKey' in spec ? words.t(spec.labelKey) : spec.label
}
export const providersIn = (category: ProviderCategory) =>
  providerNames.filter(name => providers[name].category === category)

const provider = z.enum(providerNames)
/** A Stripe secret or restricted key, test or live (the same format @linedesk/billing reads the mode from). */
const STRIPE_SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/

export const providerSetKeys = defineAction({
  name: 'provider.setKeys',
  description: 'Store keys of a provider for the whole install. Fields that are left out keep their value.',
  input: z
    .object({ provider, values: z.record(z.string(), z.string().trim().min(1).max(2000)) })
    .superRefine(({ provider, values }, ctx) => {
      const fields: Record<string, ProviderField> = providers[provider].fields
      const names = Object.keys(values)
      if (!names.length) ctx.addIssue({ code: 'custom', message: msg('server.input.provider.atLeastOneValue') })
      // Messages name the field, never the value.
      for (const name of names) {
        const field = fields[name]
        if (!field)
          ctx.addIssue({
            code: 'custom',
            message: msg('server.input.provider.noSuchField'),
            params: { provider, name },
          })
        else if (field.switch && !['true', 'false'].includes(values[name]!))
          ctx.addIssue({ code: 'custom', message: msg('server.input.provider.trueOrFalse'), params: { name } })
      }
      if (
        provider === 's3' &&
        values.endpoint !== undefined &&
        !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(values.endpoint)
      )
        ctx.addIssue({
          code: 'custom',
          message: msg('server.input.provider.s3Endpoint'),
          params: { example: 'https://s3.us-east-1.amazonaws.com' },
        })
      if (provider === 'smtp' && values.url !== undefined && !/^smtps?:\/\/\S+$/i.test(values.url))
        ctx.addIssue({ code: 'custom', message: msg('server.input.provider.smtpUrl') })
      if (provider === 'oidc' && values.discovery_url !== undefined && !/^https:\/\/\S+$/i.test(values.discovery_url))
        ctx.addIssue({ code: 'custom', message: msg('server.input.provider.discoveryUrl') })
      if (provider === 's3' && values.prefix !== undefined && !isRecordingPrefix(values.prefix))
        ctx.addIssue({ code: 'custom', message: msg('server.input.provider.s3Prefix') })
      if (provider === 'stripe' && values.secret_key !== undefined && !STRIPE_SECRET_KEY.test(values.secret_key))
        ctx.addIssue({
          code: 'custom',
          message: msg('server.input.provider.stripeSecretKey'),
        })
      const signingSecrets = {
        webhook_secret: msg('server.input.provider.stripeWebhookSecret'),
        webhook_secret_previous: msg('server.input.provider.stripeWebhookSecretPrevious'),
      }
      for (const [field, message] of Object.entries(signingSecrets))
        if (provider === 'stripe' && values[field] !== undefined && !/^whsec_[A-Za-z0-9]+$/.test(values[field]))
          ctx.addIssue({ code: 'custom', message })
    }),
  permission: 'instance:admin',
  sensitive: ['values'],
})

export const providerClearKeys = defineAction({
  name: 'provider.clearKeys',
  description: 'Remove the stored keys of a provider. The environment variables apply again.',
  input: z.object({ provider }).strict(),
  permission: 'instance:admin',
})

export const providerSetActive = defineAction({
  name: 'provider.setActive',
  description:
    'Choose the provider a category uses, for example Twilio for telephony. Without a provider the default applies again. OpenAI as language model or transcription without a key of its own uses the OpenAI key connected for the realtime model.',
  input: z
    .object({ category: z.enum(categoryNames), provider: provider.nullable() })
    .refine(i => i.provider === null || providers[i.provider].category === i.category, {
      message: msg('server.input.provider.otherCategory'),
    })
    .refine(i => !isMultiCategory(i.category), { message: msg('server.input.provider.categoryInUse') }),
  permission: 'instance:admin',
})

export const providerTest = defineAction({
  name: 'provider.test',
  description:
    'Check that a provider can do its job with the keys in effect: the key, and where the provider tells, quota or credit, the account, and that the configured model, voice or bucket exists. free: only what costs nothing (no tokens, no speech, no transcription), as the background health check does.',
  input: z.object({ provider, free: z.boolean().optional() }),
  permission: 'instance:admin',
  readOnly: true,
})
/**
 * A test's result. `ok` is false only for `status: 'error'` (a warning works now). `reason` says why it failed or
 * warns; `message` names the fix. Older callers and the web app's own errors give only `ok` and `message`.
 */
export type ProviderTestData = {
  ok: boolean
  status?: ProviderCheckStatus
  reason?: ProviderFailureReason
  message: string
}

/**
 * One OpenAI key for speech, model and voice (the setup checklist's one-key mode): one step on the server. The key is
 * tested against OpenAI first; only when it works is it stored as the realtime model's key and that model picked,
 * and OpenAI transcription and language model use the same stored key where those categories have no provider
 * (a reference, not a copy: Disconnect on the realtime model ends all three). A key that fails changes nothing.
 */
export const providerConnectOneKey = defineAction({
  name: 'provider.connectOneKey',
  description:
    'Connect one OpenAI key for speech, model and voice: tested first, then stored for the realtime model, which is picked; OpenAI transcription and language model use the same key where nothing is set up. A key that fails its test changes nothing.',
  input: z.object({ apiKey: z.string().trim().min(1).max(2000) }),
  permission: 'instance:admin',
  sensitive: ['apiKey'],
})
export type ProviderConnectOneKeyData = { ok: true; message: string; linked: ProviderName[] }

const userId = z.object({ userId: z.string().min(1) })
const workspaceId = z.object({ workspaceId: z.string().min(1) })
const adminAction = <S extends z.ZodType>(name: string, description: string, input: S) =>
  defineAction({ name, description, input, permission: 'instance:admin' })

/**
 * Server admin › Users › Add user: puts someone into a workspace with a role (apps/api/src/admin-handlers.ts). A new
 * address gets an account and an invitation to the workspace, which they accept once their address is confirmed;
 * an account whose address is confirmed joins at once. `workspaceId` may be left out only for a new instance admin
 * (`admin`), who can run the server without a workspace (also the server operator's `user:create`, which makes only
 * those).
 */
export const userInvite = defineAction({
  name: 'user.invite',
  description:
    'Add someone to a workspace with a role (member unless given). A new address gets an account and an email to sign in and join; an existing account with a confirmed address joins at once. Without a workspace only a new instance admin (admin: true). There is no open sign-up: this is how a server admin adds people.',
  input: z.object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(80),
    admin: z.boolean().optional(),
    workspaceId: z.string().min(1).nullable().optional(),
    role: z.enum(membershipRoles).optional(),
  }),
  permission: 'instance:admin',
  // A new instance admin's passkey enrolment code is in the result: shown once, never logged. The rest is kept, so
  // the audit log files the entry under the workspace with whom it added (data.subject).
  secretResult: ['enrolmentCode'],
})
/** A one-time code a new instance admin needs to add their first passkey (apps/api/src/passkey-enrolment.ts). */
export type PasskeyEnrolmentData = { enrolmentCode: string; enrolmentExpiresAt: string }
/**
 * What `user.invite` did. `existing`: the address already had an account (no new one was made). `workspace.joined`:
 * `added` is a member now; `invited` joins with the emailed link once the address is confirmed. `delivery`: how
 * the one email went out, absent when none was sent (an existing account added directly).
 */
export type UserInviteData = {
  userId: string
  email: string
  existing: boolean
  delivery?: 'smtp' | 'log'
  workspace: { id: string; name: string; role: MembershipRole; joined: 'added' | 'invited' } | null
} & Partial<PasskeyEnrolmentData>

export const userDisable = adminAction(
  'user.disable',
  'Disable a user: their sessions end and they cannot sign in.',
  userId,
)
export const userEnable = adminAction('user.enable', 'Let a disabled user sign in again.', userId)
export const workspaceDisable = adminAction(
  'workspace.disable',
  'Disable a workspace: calls to its numbers are no longer answered.',
  workspaceId,
)
export const workspaceEnable = adminAction(
  'workspace.enable',
  'Answer the calls of a disabled workspace again.',
  workspaceId,
)
/**
 * Deletes a workspace and everything in it (apps/api/src/workspace-delete.ts). `name` is the workspace's name as
 * typed to confirm. Members without another workspace lose their accounts too, unless `keepAccounts` (the same name
 * as in `workspace.deleteOwn`); members of other workspaces and instance admins always keep theirs.
 */
export const workspaceDelete = adminAction(
  'workspace.delete',
  "Delete a workspace with all its data: calls, contacts, bookings, settings, members and invitations, recordings and phone numbers. Members who belong to no other workspace lose their accounts too, unless keepAccounts is true; members of other workspaces and instance admins keep theirs. Type the workspace's name to confirm.",
  z
    .object({
      workspaceId: z.string().min(1),
      name: z.string().trim().min(1).max(200),
      keepAccounts: z.boolean().optional(),
    })
    .strict(),
)
/** What `workspace.delete` did. Phone numbers: what happened at the carrier to each. */
export type WorkspaceDeleteData = {
  workspaceId: string
  name: string
  /** Rows deleted per table (only tables that had any). */
  deleted: Record<string, number>
  /** Recordings queued for deletion from their store. */
  recordings: number
  /** Accounts deleted with it (members without another workspace), by email. */
  usersDeleted: string[]
  numbers: { e164: string; carrier: 'released' | 'unrouted' | 'none' | 'left'; note?: string }[]
  /** The plan the workspace alone paid for ended with it (canceled at once in Stripe, the bill closed; LIN-647). */
  planCanceled?: boolean
}
/** The most a monthly spending cap can be, in USD: a typo should not lift it to nothing. */
export const SPENDING_CAP_MAX_USD = 100_000
export const workspaceSetSpendingCap = adminAction(
  'workspace.setSpendingCap',
  "Set a workspace's monthly spending cap in USD on the estimated call cost (null: no cap). Once reached, the assistant stops answering its calls until next month.",
  z.object({ workspaceId: z.string().min(1), capUsd: z.number().min(0).max(SPENDING_CAP_MAX_USD).nullable() }),
)
export const instanceAdminGrant = defineAction({
  name: 'instanceAdmin.grant',
  description: 'Make a user an instance admin. Without a passkey they get a one-time code for their first one.',
  input: userId,
  permission: 'instance:admin',
  // As user.invite: the code is shown once and never logged; the rest is kept, so the audit log names whom it made
  // a server admin (data.subject).
  secretResult: ['enrolmentCode'],
})
export type InstanceAdminGrantData = { userId: string; instance_admin: true } & Partial<PasskeyEnrolmentData>

/**
 * The recovery path for passkeys that does not need them: a lost device, or a passkey someone else
 * added. Removes every passkey of the user and emails them; an instance admin also gets a new
 * enrolment code for their first passkey (shown to the admin who ran it).
 */
export const userResetPasskeys = defineAction({
  name: 'user.resetPasskeys',
  description:
    'Remove every passkey of a user and email them. For an instance admin, returns a one-time code for their new first passkey.',
  input: userId.strict(),
  permission: 'instance:admin',
  secretResult: true,
})
export type UserResetPasskeysData = {
  userId: string
  removed: number
  /** Their sessions and AI agent setup links that ended with the reset. */
  sessionsEnded: number
  setupLinksEnded: number
} & Partial<PasskeyEnrolmentData>

/**
 * Only the one-time code for an instance admin's first passkey, when they have none: nothing is removed and nothing
 * ends (their sessions and AI agent setup links keep working). Refused when they have a passkey: that is
 * user.resetPasskeys, the recovery path.
 */
export const userIssuePasskeyEnrolment = defineAction({
  name: 'user.issuePasskeyEnrolment',
  description:
    'Return a one-time code for the first passkey of an instance admin who has none yet. Removes nothing and signs nobody out.',
  input: userId,
  permission: 'instance:admin',
  secretResult: true,
})
export type UserIssuePasskeyEnrolmentData = { userId: string } & PasskeyEnrolmentData
export const instanceAdminRevoke = adminAction(
  'instanceAdmin.revoke',
  'Take instance admin away from a user. The last instance admin stays.',
  userId,
)

/** How long an impersonation lasts; it is never extended. */
export const IMPERSONATION_MINUTES = 60
/** How long the reason for an impersonation must be, and may be. */
export const IMPERSONATION_REASON_MIN = 3
export const IMPERSONATION_REASON_MAX = 300

/**
 * Starts a session as another user. Only through `POST /v1/impersonation/start`, which sets the
 * session cookie; the generic action route refuses it, since an action cannot set cookies.
 */
export const userImpersonate = adminAction(
  'user.impersonate',
  `Sign in as a user to see Linedesk as they do, for ${IMPERSONATION_MINUTES} minutes. Not yourself, another instance admin or a disabled user. A reason is required and kept in the audit log; \`workspaceId\` opens the session in that workspace of theirs (else their first).`,
  z.object({
    userId: z.string().min(1),
    /** Why, in a few words ("Ticket 1234: calls not showing"): kept with the command in the audit log, and in the email to the user when that is on. */
    reason: z.string().trim().min(IMPERSONATION_REASON_MIN).max(IMPERSONATION_REASON_MAX),
    /** A workspace the user is a member of: the session opens there. Left out: their first. */
    workspaceId: z.string().min(1).optional(),
  }),
)
/** `subject`: whom it was, for the audit log (AuditSubject); `notified`: an email to the user was queued (impersonationEmails on, email over SMTP). */
export type UserImpersonateData = {
  sessionId: string
  userId: string
  workspaceId: string | null
  expiresAt: string
  subject: { email: string; workspaceId: string | null }
  notified: boolean
}

/** Ends an impersonation. Only through `POST /v1/impersonation/stop`, which restores the admin's own session cookie. */
export const impersonationStop = defineAction({
  name: 'impersonation.stop',
  description: 'Stop signing in as another user and return to your own session.',
  input: z.object({}).strict(),
  permission: 'impersonation:stop',
})

/**
 * Setup emails (day 0, 1 and 3 until the first real call, the first call, the first week's summary) to the owners of
 * new workspaces. Off by default, so a self-hosted install sends none unless its admin turns them on.
 */
export const setupEmailsGet = defineAction({
  name: 'setupEmails.get',
  description: 'Whether new workspaces of this install get setup emails until their first real call (off by default).',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const setupEmailsSet = adminAction(
  'setupEmails.set',
  'Turn setup emails to the owners of new workspaces on or off for this install. Each email still goes out at most once.',
  z.object({ on: z.boolean() }),
)
/**
 * `data` of `setupEmails.get` and `setupEmails.set`. `emailConnected`: email goes out over SMTP (not only to the
 * log); until then none are sent. `partnerDirectoryUrl`: the partner link on day 3 (PARTNER_DIRECTORY_URL), null
 * when the install has none.
 */
export type SetupEmailsData = { on: boolean; emailConnected: boolean; partnerDirectoryUrl: string | null }

/**
 * Whether a user gets an email when an instance admin signs in as them (user.impersonate): one at the start, with the
 * admin, the reason, the time and the workspace. Off by default; a common practice for support access, left to the install.
 */
export const impersonationEmailsGet = defineAction({
  name: 'impersonationEmails.get',
  description: 'Whether users are emailed when an instance admin signs in as them (off by default).',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const impersonationEmailsSet = adminAction(
  'impersonationEmails.set',
  'Turn on or off the email to a user when an instance admin signs in as them (one email at the start, with the admin, the reason and the time).',
  z.object({ on: z.boolean() }),
)
/** `data` of `impersonationEmails.get` and `.set`. `emailConnected`: email goes out over SMTP; until then none are sent. */
export type ImpersonationEmailsData = { on: boolean; emailConnected: boolean }
