import { z } from 'zod'
import { defineAction } from './define.ts'

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

export const contactUpdate = defineAction({
  name: 'contact.update',
  description: 'Update a contact.',
  input: z.object({
    contactId: z.string().min(1),
    name: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  permission: 'contact:write',
  patch: { table: 'contacts', id: i => i.contactId, set: ({ contactId: _id, ...rest }) => defined(rest) },
})

/** Longest free-text instructions an assistant takes (characters). */
export const INSTRUCTIONS_MAX = 20_000

export const assistantUpdate = defineAction({
  name: 'assistant.update',
  description: 'Update the assistant: name, greeting, voice, whether calls are recorded and what it knows about the business.',
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().min(1).optional(),
    greeting: z.string().optional(),
    disclose_ai: z.boolean().optional(),
    record_calls: z.boolean().optional(),
    voice: z.object({ provider: z.string(), voice_id: z.string() }).optional(),
    business_profile: z.object({
      instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
      description: z.string().optional(),
      services: z.array(z.string()).optional(),
      service_area: z.string().optional(),
      address: z.string().optional(),
      hours: z.string().optional(),
      faqs: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
    }).optional(),
  }),
  permission: 'settings:write',
  patch: { table: 'assistants', id: i => i.assistantId, set: ({ assistantId: _id, ...rest }) => defined(rest) },
})

export const phoneNumberModes = ['forward_conditional', 'forward_all', 'new', 'ported'] as const

export const phoneNumberSetup = defineAction({
  name: 'phoneNumber.setup',
  description:
    'Connect a phone number to the workspace and route its calls to the assistant. By default it attaches `e164`, a number that already exists in the carrier account, and buys nothing. With `purchase: true` it buys `e164`, or the first free number in `areaCode`, which costs money. Repeating it for the same number finishes a setup that failed halfway.',
  input: z.object({
    e164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    areaCode: z.string().regex(/^\d{3}$/).optional(),
    /** Buying is never implied: without this, a number that is not in the account is rejected. */
    purchase: z.boolean().default(false),
    /** How the business uses the number. Default: `new` for a bought number, `forward_conditional` for an attached one. */
    mode: z.enum(phoneNumberModes).optional(),
  })
    .refine(i => i.e164 || i.areaCode, { message: 'give a number (e164) or an area code' })
    .refine(i => i.e164 || i.purchase, { message: 'an area code alone means buying a number: pass purchase: true, or give the number (e164) to attach' }),
  permission: 'settings:write',
})

// Talking to the assistant from the web app. Read-only for the action runner: it writes no rows,
// and its result (a LiveKit token) must not be kept in the command log.
export const assistantStartTestCall = defineAction({
  name: 'assistant.startTestCall',
  description: 'Start a test call with the assistant in the browser: returns a short-lived LiveKit token for a new room the assistant joins.',
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})
/** `data` of `assistant.startTestCall`: where and how the browser joins. The token can join only `room`. */
export type TestCallData = { url: string; token: string; room: string; expiresAt: string }
