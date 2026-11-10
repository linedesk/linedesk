// The admin area: actions for the operator of the install. All need `instance:admin`, which no
// workspace role has. They change tables that are not synced, so none has a `patch`.
import { z } from 'zod'
import { defineAction } from './define.ts'

export type ProviderCategory = 'telephony' | 'stt' | 'llm' | 'tts'
export const providerCategories: Record<ProviderCategory, string> = {
  telephony: 'Telephony',
  stt: 'Speech to text',
  llm: 'Language model',
  tts: 'Voice',
}
/** The variable that picks a category's provider when none is picked in the admin area. */
export const categoryEnv: Record<ProviderCategory, string> = {
  telephony: 'TELEPHONY_PROVIDER',
  stt: 'STT_PROVIDER',
  llm: 'LLM_PROVIDER',
  tts: 'TTS_PROVIDER',
}
export const categoryNames = Object.keys(providerCategories) as [ProviderCategory, ...ProviderCategory[]]

/** `env` is the variable used when nothing is stored in the app. `optional` fields are not needed for a connection. */
type ProviderField = { label: string; env: string; secret: boolean; optional?: true }
type ProviderSpec = { label: string; category: ProviderCategory; fields: Record<string, ProviderField> }

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
    fields: { api_key: apiKey('OPENROUTER_API_KEY'), model: model('LLM_MODEL') },
  },
  openai: {
    label: 'OpenAI',
    category: 'llm',
    fields: { api_key: apiKey('OPENAI_API_KEY'), model: model('LLM_MODEL') },
  },
  elevenlabs: {
    label: 'ElevenLabs',
    category: 'tts',
    fields: { api_key: apiKey('ELEVENLABS_API_KEY'), ...voiceFields },
  },
  cartesia: { label: 'Cartesia', category: 'tts', fields: { api_key: apiKey('CARTESIA_API_KEY'), ...voiceFields } },
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
        if (!fields[name]) ctx.addIssue({ code: 'custom', message: `${provider} has no field ${name}` })
      }
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
    }),
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
export const instanceAdminGrant = adminAction('instanceAdmin.grant', 'Make a user an instance admin.', userId)
export const instanceAdminRevoke = adminAction(
  'instanceAdmin.revoke',
  'Take instance admin away from a user. The last instance admin stays.',
  userId,
)
