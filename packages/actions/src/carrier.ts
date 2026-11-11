// A workspace's own carrier account: by default a workspace uses the install's telephony provider
// (Admin, Providers); an owner or admin can bring their own Twilio or Telnyx account instead. The
// credentials are stored encrypted per workspace and never come back to the browser.
import { z } from 'zod'
import { defineAction } from './define.ts'

export const workspaceCarriers = ['default', 'twilio', 'telnyx'] as const
export type WorkspaceCarrier = (typeof workspaceCarriers)[number]
export type OwnCarrier = Exclude<WorkspaceCarrier, 'default'>

type CarrierField = { label: string; secret: boolean }
/** The fields of each own carrier, in the order the form shows them. */
export const carrierFields: Record<OwnCarrier, Record<string, CarrierField>> = {
  twilio: {
    account_sid: { label: 'Account SID', secret: false },
    api_key_sid: { label: 'API key SID', secret: false },
    api_key_secret: { label: 'API key secret', secret: true },
    auth_token: { label: 'Auth token', secret: true },
  },
  telnyx: { api_key: { label: 'API key', secret: true } },
}

const secret = z.string().trim().min(1).max(2000)
const sid = (prefix: string, what: string) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`), `${what} starts with ${prefix} followed by 32 letters and digits`)

const twilioValues = z
  .object({
    account_sid: sid('AC', 'The Account SID'),
    api_key_sid: sid('SK', 'The API key SID').optional(),
    api_key_secret: secret.optional(),
    auth_token: secret.optional(),
  })
  .strict()
  .refine(v => !!v.auth_token !== !!(v.api_key_sid && v.api_key_secret), {
    message: 'give either an API key (SID and secret) or the auth token',
  })
  .refine(v => !!v.api_key_sid === !!v.api_key_secret, { message: 'an API key needs its SID and its secret' })

export const carrierSet = defineAction({
  name: 'carrier.set',
  description:
    "Choose the carrier account the workspace's phone numbers use: `default` (the install's), or the workspace's own Twilio or Telnyx account with its credentials. The credentials are replaced as a whole and stored encrypted.",
  input: z.discriminatedUnion('carrier', [
    z.object({ carrier: z.literal('default') }).strict(),
    z.object({ carrier: z.literal('twilio'), values: twilioValues }).strict(),
    z.object({ carrier: z.literal('telnyx'), values: z.object({ api_key: secret }).strict() }).strict(),
  ]),
  permission: 'settings:write',
  sensitive: ['values'],
})

export const carrierGet = defineAction({
  name: 'carrier.get',
  description:
    'Read which carrier account the workspace uses and which of its credentials are set. Secrets are never returned.',
  input: z.object({}).strict(),
  permission: 'settings:write',
  readOnly: true,
})

export const carrierTest = defineAction({
  name: 'carrier.test',
  description:
    "Check the workspace's own carrier credentials by listing the numbers of the account. Reads only: buys and changes nothing.",
  input: z.object({}).strict(),
  permission: 'settings:write',
  readOnly: true,
})

export type CarrierFieldStatus = {
  field: string
  label: string
  secret: boolean
  set: boolean
  /** The value of a field that is not secret (the account SID). */
  value: string | null
  /** The last four characters of a stored secret of 12 characters or more. */
  last4: string | null
}
/** `data` of carrier.get. `fields` are those of the workspace's own carrier, empty for `default`. */
export type CarrierStatusData = {
  carrier: WorkspaceCarrier
  /** Whether the server can store credentials (SECRETS_KEY is set). */
  canStore: boolean
  fields: CarrierFieldStatus[]
  updatedAt: string | null
}
/** `data` of carrier.test. */
export type CarrierTestData = { ok: boolean; message: string }
