// The admin area: actions for the operator of the install. All need `instance:admin`, which no
// workspace role has. They change tables that are not synced, so none has a `patch`.
import { z } from 'zod'
import { isRecordingPrefix } from './calls.ts'
import { defineAction } from './define.ts'

export type ProviderCategory = 'telephony' | 'stt' | 'llm' | 'tts' | 'email' | 'sign_in' | 'recording'
export const providerCategories: Record<ProviderCategory, string> = {
  telephony: 'Telephony',
  stt: 'Speech to text',
  llm: 'Language model',
  tts: 'Voice',
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
  openai: {
    label: 'OpenAI',
    category: 'llm',
    fields: {
      api_key: apiKey('OPENAI_API_KEY'),
      model: { ...model('LLM_MODEL'), hint: 'gpt-4.1-mini' },
      summary_model: {
        label: 'Summary model',
        env: 'SUMMARY_MODEL',
        secret: false,
        optional: true,
        hint: 'gpt-4.1-mini',
      },
    },
  },
  elevenlabs: {
    label: 'ElevenLabs',
    category: 'tts',
    fields: { api_key: apiKey('ELEVENLABS_API_KEY'), ...voiceFields },
  },
  cartesia: { label: 'Cartesia', category: 'tts', fields: { api_key: apiKey('CARTESIA_API_KEY'), ...voiceFields } },
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
      from: { label: 'From', env: 'EMAIL_FROM', secret: false, optional: true, hint: 'Linedesk <no-reply@example.com>' },
    },
    help: 'Sends sign-in codes, invitations and call emails. Any mail service with SMTP: Postmark, Resend, Amazon SES, Mailgun or your own server.',
    presets: [
      {
        label: 'Postmark',
        values: { url: 'smtp://<server-token>:<server-token>@smtp.postmarkapp.com:587' },
        help: 'Replace both <server-token> with your Postmark server API token.',
      },
      {
        label: 'Resend',
        values: { url: 'smtps://resend:<api-key>@smtp.resend.com:465' },
        help: 'Replace <api-key> with a Resend API key.',
      },
      {
        label: 'Amazon SES',
        values: { url: 'smtps://<smtp-user>:<smtp-password>@email-smtp.<region>.amazonaws.com:465' },
        help: 'Use SES SMTP credentials (not your AWS access key) and your region, e.g. us-east-1.',
      },
    ],
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
      display_name: { label: 'Button label', env: 'OIDC_DISPLAY_NAME', secret: false, optional: true, hint: 'Single sign-on' },
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
  description: 'Check the keys in effect for a provider with one authenticated request.',
  input: z.object({ provider }),
  permission: 'instance:admin',
  readOnly: true,
})
export type ProviderTestData = { ok: boolean; message: string }

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
  description: "Remove every passkey of a user and email them. For an instance admin, returns a one-time code for their new first passkey.",
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
