// The admin area: actions for the operator of the install. All need `instance:admin`, which no
// workspace role has. They change tables that are not synced, so none has a `patch`.
import { z } from 'zod'
import { isRecordingPrefix } from './calls.ts'
import { defineAction } from './define.ts'
import type { ProviderCheckStatus, ProviderFailureReason } from './provider-health.ts'

export type ProviderCategory = 'telephony' | 'stt' | 'llm' | 'tts' | 'realtime' | 'email' | 'sign_in' | 'recording'
export const providerCategories: Record<ProviderCategory, string> = {
  telephony: 'Telephony',
  stt: 'Speech to text',
  llm: 'Language model',
  tts: 'Voice',
  realtime: 'Realtime model',
  email: 'Email',
  sign_in: 'Sign-in and calendar',
  recording: 'Recording storage',
}

/** Categories where every provider that is set up is in use at once (no pick): sign-in with Google and GitHub, say. */
export const multiCategories: readonly ProviderCategory[] = ['sign_in']
export const isMultiCategory = (category: ProviderCategory) => multiCategories.includes(category)

/**
 * Categories the API reads once at start (Better Auth's sign-in providers, the mail transport): a
 * change there restarts the API, which takes a few seconds (instance-env.ts). The others apply at once.
 */
export const restartCategories: readonly ProviderCategory[] = ['email', 'sign_in']
/** The variable that picks a category's provider when none is picked in the admin area. */
export const categoryEnv: Partial<Record<ProviderCategory, string>> = {
  telephony: 'TELEPHONY_PROVIDER',
  stt: 'STT_PROVIDER',
  llm: 'LLM_PROVIDER',
  tts: 'TTS_PROVIDER',
  email: 'EMAIL_PROVIDER',
  recording: 'RECORDING_STORE',
}
export const categoryNames = Object.keys(providerCategories) as [ProviderCategory, ...ProviderCategory[]]

/**
 * `env` is the variable used when nothing is stored in the app. `optional` fields are not needed for a
 * connection. `hint` says what an empty field means (shown in the empty input). `switch` fields hold
 * "true" or "false" and show as a checkbox.
 */
type ProviderField = { label: string; env: string; secret: boolean; optional?: true; hint?: string; switch?: true }
/** Values the edit form can fill in for a known service (`<...>` parts are the operator's to replace). */
export type ProviderPreset = { label: string; values: Record<string, string>; help: string }
/** `help` is shown on the provider's card. */
type ProviderSpec = {
  label: string
  category: ProviderCategory
  fields: Record<string, ProviderField>
  help?: string
  presets?: readonly ProviderPreset[]
}

const apiKey = (env: string): ProviderField => ({ label: 'API key', env, secret: true })
const model = (env: string): ProviderField => ({ label: 'Model', env, secret: false, optional: true })
/**
 * Where each language-model provider answers (OpenAI-compatible chat completions) and its default models: `models`
 * for live turns (first one first, then fallbacks), `summaryModels` for the summary and other background work.
 * Live turns need the fastest first token (gemini-2.5-flash-lite about 0.6 s from the server, gpt-5.4-mini about
 * 1.05 s); the summary is not latency-critical and gets a stronger model. Used by the agent and the API alike.
 */
export const llmEndpoints = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['google/gemini-2.5-flash-lite', 'openai/gpt-4.1-mini'],
    summaryModels: ['google/gemini-2.5-flash', 'openai/gpt-5.4-mini'],
  },
  openai: { baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini'], summaryModels: ['gpt-4.1-mini'] },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-haiku-5-5'],
    summaryModels: ['claude-sonnet-5-5'],
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash-lite'],
    summaryModels: ['gemini-2.5-flash'],
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile'],
    summaryModels: ['llama-3.3-70b-versatile'],
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
    summaryModels: ['mistral-medium-latest'],
  },
} as const satisfies Record<string, { baseUrl: string; models: readonly string[]; summaryModels: readonly string[] }>
export type LlmProvider = keyof typeof llmEndpoints

/** A language-model provider's fields: its key, the live model and the summary model (hints: its defaults). */
const llmFields = (keyEnv: string, provider: Exclude<LlmProvider, 'openrouter'>): Record<string, ProviderField> => ({
  api_key: apiKey(keyEnv),
  model: { ...model('LLM_MODEL'), hint: llmEndpoints[provider].models.join(', ') },
  summary_model: {
    label: 'Summary model',
    env: 'SUMMARY_MODEL',
    secret: false,
    optional: true,
    hint: llmEndpoints[provider].summaryModels.join(', '),
  },
})

/** Every mail service's sender. Empty: the service's default (Gmail: its address), else "Linedesk <no-reply@localhost>". */
const emailFrom: ProviderField = {
  label: 'From',
  env: 'EMAIL_FROM',
  secret: false,
  optional: true,
  hint: 'no-reply@example.com, or Name <no-reply@example.com>',
}
const voiceFields = {
  model: model('TTS_MODEL'),
  voice_id: { label: 'Default voice', env: 'TTS_VOICE_ID', secret: false, optional: true },
} as const

/**
 * The providers an instance admin can set up. To add one: an entry here, and how to test its
 * connection in apps/api/src/provider-test.ts. The database stores provider id and field name as
 * text, so a new provider needs no migration. Env names follow the voice agent's (apps/agent/src/config.ts).
 */
export const providers = {
  telnyx: {
    label: 'Telnyx',
    category: 'telephony',
    fields: {
      api_key: apiKey('TELNYX_API_KEY'),
      public_key: { label: 'Webhook public key', env: 'TELNYX_PUBLIC_KEY', secret: false, optional: true },
    },
  },
  twilio: {
    label: 'Twilio',
    category: 'telephony',
    fields: {
      account_sid: { label: 'Account SID', env: 'TWILIO_ACCOUNT_SID', secret: false },
      auth_token: { label: 'Auth token', env: 'TWILIO_AUTH_TOKEN', secret: true },
    },
  },
  deepgram: {
    label: 'Deepgram',
    category: 'stt',
    fields: { api_key: apiKey('DEEPGRAM_API_KEY'), model: model('STT_MODEL') },
  },
  // Streaming speech recognition with the provider's own end-of-turn detection. Own key variables: a key for the voice
  // or the language model in the environment must not switch speech recognition over.
  elevenlabs_stt: {
    label: 'ElevenLabs Scribe',
    category: 'stt',
    fields: { api_key: apiKey('ELEVENLABS_STT_API_KEY'), model: { ...model('STT_MODEL'), hint: 'scribe_v2_realtime' } },
  },
  openai_stt: {
    label: 'OpenAI transcription',
    category: 'stt',
    fields: { api_key: apiKey('OPENAI_STT_API_KEY'), model: { ...model('STT_MODEL'), hint: 'gpt-4o-mini-transcribe' } },
  },
  openrouter: {
    label: 'OpenRouter',
    category: 'llm',
    fields: {
      api_key: apiKey('OPENROUTER_API_KEY'),
      model: {
        ...model('LLM_MODEL'),
        hint: 'google/gemini-2.5-flash-lite, openai/gpt-4.1-mini (fallbacks after a comma)',
      },
      summary_model: {
        label: 'Summary model',
        env: 'SUMMARY_MODEL',
        secret: false,
        optional: true,
        hint: 'google/gemini-2.5-flash, openai/gpt-5.4-mini',
      },
    },
  },
  openai: { label: 'OpenAI', category: 'llm', fields: llmFields('OPENAI_API_KEY', 'openai') },
  anthropic: { label: 'Anthropic', category: 'llm', fields: llmFields('ANTHROPIC_API_KEY', 'anthropic') },
  gemini: { label: 'Google Gemini', category: 'llm', fields: llmFields('GEMINI_API_KEY', 'gemini') },
  groq: { label: 'Groq', category: 'llm', fields: llmFields('GROQ_API_KEY', 'groq') },
  mistral: { label: 'Mistral', category: 'llm', fields: llmFields('MISTRAL_API_KEY', 'mistral') },
  elevenlabs: {
    label: 'ElevenLabs',
    category: 'tts',
    fields: { api_key: apiKey('ELEVENLABS_API_KEY'), ...voiceFields },
  },
  cartesia: { label: 'Cartesia', category: 'tts', fields: { api_key: apiKey('CARTESIA_API_KEY'), ...voiceFields } },
  // A speech-to-speech model: hears the caller and answers in its own voice. Once connected it is the default for
  // assistants (each can pick the three stages above instead: `voice_pipeline`). The summary after the call goes to
  // OpenAI's chat API with the same key. Its own key variable: an OPENAI_API_KEY for the language model must not
  // switch calls to realtime.
  openai_realtime: {
    label: 'OpenAI Realtime',
    category: 'realtime',
    fields: {
      api_key: apiKey('OPENAI_REALTIME_API_KEY'),
      model: { ...model('REALTIME_MODEL'), hint: 'gpt-realtime' },
      voice: { label: 'Voice', env: 'REALTIME_VOICE', secret: false, optional: true, hint: 'marin' },
      summary_model: {
        label: 'Summary model',
        env: 'REALTIME_SUMMARY_MODEL',
        secret: false,
        optional: true,
        hint: 'gpt-4.1-mini',
      },
    },
    help: 'Once connected, it answers calls with one speech-to-speech model in its own voice, instead of speech to text, language model and voice; disconnect it to go back. Warm transfer, the assistant’s voice and the cached greeting are not available then.',
  },
  // Recording storage: where LiveKit egress writes call audio and the API reads it. Not a paid API, but
  // the same model: one active store, keys stored encrypted, env as fallback. No first-set-up fallback:
  // without a pick or RECORDING_STORE, calls are not recorded (apps/api/src/provider-settings.ts).
  file: {
    label: 'Local disk',
    category: 'recording',
    fields: {},
    help: 'Recordings stay on this server.',
  },
  s3: {
    label: 'S3-compatible',
    category: 'recording',
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
  // Mail services with a key or an app password instead of an SMTP URL. The API turns their fields into the SMTP
  // connection it sends with (apps/api/src/email-services.ts). One of them sends: the one picked, else the first set up.
  resend: {
    label: 'Resend',
    category: 'email',
    fields: { api_key: apiKey('RESEND_API_KEY'), from: emailFrom },
    help: 'An API key with sending access. The From address must be on a domain verified in Resend.',
  },
  postmark: {
    label: 'Postmark',
    category: 'email',
    fields: {
      server_token: { label: 'Server API token', env: 'POSTMARK_SERVER_TOKEN', secret: true },
      from: emailFrom,
    },
    help: 'The server API token of a Postmark server. The From address must be a verified sender signature or domain.',
  },
  sendgrid: {
    label: 'SendGrid',
    category: 'email',
    fields: { api_key: apiKey('SENDGRID_API_KEY'), from: emailFrom },
    help: 'An API key with Mail Send access. The From address must be a verified sender in SendGrid.',
  },
  brevo: {
    label: 'Brevo',
    category: 'email',
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
    fields: {
      client_id: { label: 'Client ID', env: 'GOOGLE_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'GOOGLE_CLIENT_SECRET', secret: true },
    },
    help: 'In Google Cloud, create an OAuth client (Web application) with the redirect URIs below. For calendars the consent screen lists calendar.events, calendar.freebusy and calendar.calendarlist.readonly.',
  },
  microsoft: {
    label: 'Microsoft',
    category: 'sign_in',
    fields: {
      client_id: { label: 'Application (client) ID', env: 'MICROSOFT_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'MICROSOFT_CLIENT_SECRET', secret: true },
      tenant_id: { label: 'Tenant', env: 'MICROSOFT_TENANT_ID', secret: false, optional: true, hint: 'common' },
    },
    help: 'In Microsoft Entra, register an app (Web) with the redirect URIs below and the delegated permissions Calendars.ReadWrite, offline_access and User.Read. Work accounts sign in only with the optional ID-token claims xms_edov and email (Token configuration). Tenant: an ID limits sign-in to one organization.',
  },
  github: {
    label: 'GitHub',
    category: 'sign_in',
    fields: {
      client_id: { label: 'Client ID', env: 'GITHUB_CLIENT_ID', secret: false },
      client_secret: { label: 'Client secret', env: 'GITHUB_CLIENT_SECRET', secret: true },
    },
    help: 'Create an OAuth app under GitHub, Developer settings, with the callback URL below. Only the primary email, and only when GitHub verified it, signs anyone in.',
  },
  oidc: {
    label: 'Single sign-on (OIDC)',
    category: 'sign_in',
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
} as const satisfies Record<string, ProviderSpec>

export type ProviderName = keyof typeof providers
export const providerNames = Object.keys(providers) as [ProviderName, ...ProviderName[]]
export const providerSpec = (name: ProviderName): ProviderSpec => providers[name]
export const providersIn = (category: ProviderCategory) =>
  providerNames.filter(name => providers[name].category === category)

const provider = z.enum(providerNames)

export const providerSetKeys = defineAction({
  name: 'provider.setKeys',
  description: 'Store keys of a provider for the whole install. Fields that are left out keep their value.',
  input: z
    .object({ provider, values: z.record(z.string(), z.string().trim().min(1).max(2000)) })
    .superRefine(({ provider, values }, ctx) => {
      const fields: Record<string, ProviderField> = providers[provider].fields
      const names = Object.keys(values)
      if (!names.length) ctx.addIssue({ code: 'custom', message: 'give at least one value' })
      // Messages name the field, never the value.
      for (const name of names) {
        const field = fields[name]
        if (!field) ctx.addIssue({ code: 'custom', message: `${provider} has no field ${name}` })
        else if (field.switch && !['true', 'false'].includes(values[name]!))
          ctx.addIssue({ code: 'custom', message: `${name} must be true or false` })
      }
      if (
        provider === 's3' &&
        values.endpoint !== undefined &&
        !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(values.endpoint)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'endpoint must be an http(s) URL, e.g. https://s3.us-east-1.amazonaws.com',
        })
      if (provider === 'smtp' && values.url !== undefined && !/^smtps?:\/\/\S+$/i.test(values.url))
        ctx.addIssue({ code: 'custom', message: 'the SMTP URL starts with smtp:// or smtps://' })
      if (provider === 'oidc' && values.discovery_url !== undefined && !/^https:\/\/\S+$/i.test(values.discovery_url))
        ctx.addIssue({ code: 'custom', message: 'the discovery URL must be an https URL' })
      if (provider === 's3' && values.prefix !== undefined && !isRecordingPrefix(values.prefix))
        ctx.addIssue({ code: 'custom', message: 'prefix may only hold letters, digits, - _ . and /' })
    }),
  permission: 'instance:admin',
  sensitive: ['values'],
})

export const providerClearKeys = defineAction({
  name: 'provider.clearKeys',
  description: 'Remove the stored keys of a provider. The environment variables apply again.',
  input: z.object({ provider }),
  permission: 'instance:admin',
})

export const providerSetActive = defineAction({
  name: 'provider.setActive',
  description:
    'Choose the provider a category uses, for example Twilio for telephony. Without a provider the default applies again.',
  input: z
    .object({ category: z.enum(categoryNames), provider: provider.nullable() })
    .refine(i => i.provider === null || providers[i.provider].category === i.category, {
      message: 'that provider belongs to another category',
    })
    .refine(i => !isMultiCategory(i.category), { message: 'every provider set up in this category is in use' }),
  permission: 'instance:admin',
})

export const providerTest = defineAction({
  name: 'provider.test',
  description:
    'Check that a provider can do its job with the keys in effect: the key, and where the provider tells, quota or credit, the account, and that the configured model, voice or bucket exists.',
  input: z.object({ provider }),
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

const userId = z.object({ userId: z.string().min(1) })
const workspaceId = z.object({ workspaceId: z.string().min(1) })
const adminAction = <S extends z.ZodType>(name: string, description: string, input: S) =>
  defineAction({ name, description, input, permission: 'instance:admin' })

export const userInvite = defineAction({
  name: 'user.invite',
  description: 'Create an account for someone and email them how to sign in. Works while sign-up is closed.',
  input: z.object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(80),
    admin: z.boolean().optional(),
  }),
  permission: 'instance:admin',
  // A new instance admin's passkey enrolment code is in the result: shown once, never logged.
  secretResult: true,
})
/** A one-time code a new instance admin needs to add their first passkey (apps/api/src/passkey-enrolment.ts). */
export type PasskeyEnrolmentData = { enrolmentCode: string; enrolmentExpiresAt: string }
export type UserInviteData = { userId: string; email: string; delivery: 'smtp' | 'log' } & Partial<PasskeyEnrolmentData>

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
  secretResult: true,
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
  input: userId,
  permission: 'instance:admin',
  secretResult: true,
})
export type UserResetPasskeysData = { userId: string; removed: number } & Partial<PasskeyEnrolmentData>
export const instanceAdminRevoke = adminAction(
  'instanceAdmin.revoke',
  'Take instance admin away from a user. The last instance admin stays.',
  userId,
)

/** How long an impersonation lasts; it is never extended. */
export const IMPERSONATION_MINUTES = 60

/**
 * Starts a session as another user. Only through `POST /v1/impersonation/start`, which sets the
 * session cookie; the generic action route refuses it, since an action cannot set cookies.
 */
export const userImpersonate = adminAction(
  'user.impersonate',
  `Sign in as a user to see Linedesk as they do, for ${IMPERSONATION_MINUTES} minutes. Not yourself, another instance admin or a disabled user.`,
  userId,
)
export type UserImpersonateData = { sessionId: string; userId: string; workspaceId: string | null; expiresAt: string }

/** Ends an impersonation. Only through `POST /v1/impersonation/stop`, which restores the admin's own session cookie. */
export const impersonationStop = defineAction({
  name: 'impersonation.stop',
  description: 'Stop signing in as another user and return to your own session.',
  input: z.object({}).strict(),
  permission: 'impersonation:stop',
})
