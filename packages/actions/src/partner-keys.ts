// A white-label partner's own provider keys (docs/white-label.md, slice S7): the partner's owner connects its own
// speech to text, language model, voice and realtime accounts, and switches them on per client workspace. A call of a
// switched-on client that runs fully on the partner's keys (and the client's own carrier) has no usage fee. Keys are
// stored encrypted and never come back: reads give the provider, the last four characters and the test result only.
import { z } from 'zod'
import { type ProviderName, providers } from './admin.ts'
import { defineAction } from './define.ts'

/** The stages a partner can run on its own keys, in the order the page shows them. */
export const PARTNER_KEY_STAGES = ['stt', 'llm', 'tts', 'realtime'] as const
export type PartnerKeyStage = (typeof PARTNER_KEY_STAGES)[number]
export type PartnerKeyStatus = 'untested' | 'ok' | 'failing'

/** The providers a stage can use: the install's registry entries of that category. */
export const partnerKeyProviders = (stage: PartnerKeyStage): ProviderName[] =>
  (Object.keys(providers) as ProviderName[]).filter(name => providers[name].category === stage)

/** One stage as the partner area shows it. Never a key: the provider, the last four characters, the test. */
export type PartnerKeyRow = {
  stage: PartnerKeyStage
  provider: ProviderName | null
  last4: string | null
  status: PartnerKeyStatus | null
  /** Why the last test or call failed (masked, short); null when it works or was not tried. */
  failure: string | null
  checkedAt: string | null
  updatedAt: string | null
}

/** `partnerKeys.get`: the stages, whether the owner can change them, and the admin kill switch. */
export type PartnerKeysData = {
  stages: PartnerKeyRow[]
  canEdit: boolean
  /** An instance admin turned own keys off for this partner (partnerKeys.adminDisable): the reason. */
  disabled: { reason: string; at: string } | null
  /** Speech, model and voice, or the realtime model, connected and working: calls can run on them. */
  ready: { threeStage: boolean; realtime: boolean }
}

/**
 * Why a partner keys action was refused, as the rejection's `code`: the web app shows `team.partner.keys.error.<code>`.
 */
export const PARTNER_KEY_CODES = [
  'keys_disabled',
  'wrong_stage',
  'no_secrets_key',
  'client_not_found',
  'clone_on_install_keys',
  'too_many_tests',
  'key_unreadable',
] as const
export type PartnerKeyCode = (typeof PARTNER_KEY_CODES)[number]

const partnerId = z.string().min(1).max(64)
const stage = z.enum(PARTNER_KEY_STAGES)
const providerName = z.enum(Object.keys(providers) as [ProviderName, ...ProviderName[]])

export const partnerKeysGet = defineAction({
  name: 'partnerKeys.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The partner's own provider keys per stage (speech to text, language model, voice, realtime model): the provider, the key's last four characters and the last test. Never a key. Anyone on the partner's team.",
  input: z.object({ partnerId }),
  permission: 'partner',
  readOnly: true,
})

export const partnerKeysSet = defineAction({
  name: 'partnerKeys.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Connect the partner's own API key for one stage (speech to text, language model, voice or realtime model) and test it. Replaces the stage's key. The partner's owner only, signed in recently.",
  input: z
    .object({ partnerId, stage, provider: providerName, apiKey: z.string().trim().min(8).max(2000) })
    .refine(i => providers[i.provider].category === i.stage, {
      // i18n-ignore: a validation message for API clients; the partner area shows team.partner.keys.error.wrong_stage
      message: 'that provider belongs to another stage',
      path: ['provider'],
    }),
  permission: 'partner',
  sensitive: ['apiKey'],
})

export const partnerKeysClear = defineAction({
  name: 'partnerKeys.clear',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove the partner's own key of one stage. Calls of switched-on clients then run on the install's keys and are billed. The partner's owner only.",
  input: z.object({ partnerId, stage }),
  permission: 'partner',
})

export const partnerKeysTest = defineAction({
  name: 'partnerKeys.test',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Test the partner's own key of one stage again (only what costs nothing). The partner's owner only; a few per 10 minutes.",
  input: z.object({ partnerId, stage }),
  permission: 'partner',
})

export const partnerSetClientOwnKeys = defineAction({
  name: 'partner.setClientOwnKeys',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Switch a client workspace to the partner's own provider keys, or back. Its calls have no usage fee when every stage runs on the partner's keys and the client uses its own carrier. The partner's owner only.",
  input: z.object({ partnerId, workspaceId: z.string().min(1).max(64), on: z.boolean() }),
  permission: 'partner',
})

export const partnerKeysAdminDisable = defineAction({
  name: 'partnerKeys.adminDisable',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Turn a partner's own provider keys off (Server admin › Partners): its calls run on the install's keys and are billed, and its owner is emailed with the reason. Never shows a key.",
  input: z.object({ partnerId, reason: z.string().trim().min(3).max(300) }),
  permission: 'instance:admin',
})

export const partnerKeysAdminEnable = defineAction({
  name: 'partnerKeys.adminEnable',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: "Turn a partner's own provider keys on again after partnerKeys.adminDisable.",
  input: z.object({ partnerId }),
  permission: 'instance:admin',
})

export { KEY_SOURCES, type KeySources, keySourcesInput, keysConfirmed } from './key-sources.ts'
