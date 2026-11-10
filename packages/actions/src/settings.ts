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

export const phoneNumberSetup = defineAction({
  name: 'phoneNumber.setup',
  description: 'Get a phone number for the workspace from the telephony provider and route its calls to the assistant. Buys `e164`, or the first available number in `areaCode`. Repeating it for the same `e164` finishes a setup that failed halfway.',
  input: z.object({
    e164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    areaCode: z.string().regex(/^\d{3}$/).optional(),
  }).refine(i => i.e164 || i.areaCode, { message: 'give a number (e164) or an area code' }),
  permission: 'settings:write',
})
