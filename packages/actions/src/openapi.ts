// The public API as an OpenAPI 3.1 document, generated from the registry: one path per action
// marked `public`, its input schema straight from the action's Zod schema.
import { z } from 'zod'
import type { ActionDef } from './define.ts'
import {
  CALL_END_DELAY_SEC,
  CALL_START_TIMEOUT_MS,
  callEndPayloadSchema,
  callStartReplySchema,
  callStartRequestSchema,
  DURING_CALL_TIMEOUT_MS,
  duringCallReplySchema,
  duringCallRequestSchema,
} from './webhooks.ts'
import { INTEGRATION_SAMPLE_CALLS_MAX, integrationCallSchema } from './integrations.ts'

type JsonSchema = Record<string, unknown>

const ok: JsonSchema = {
  type: 'object',
  required: ['ok', 'rows'],
  properties: {
    ok: { const: true },
    rows: { type: 'object', description: 'The rows the action wrote, by table.', additionalProperties: { type: 'array', items: { type: 'object' } } },
    data: { type: 'object', description: 'What the action returns besides rows (for example the free slots).' },
  },
}
const rejection: JsonSchema = { type: 'object', required: ['ok', 'error'], properties: { ok: { const: false }, error: { type: 'string' } } }
const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Rejection' } } } })

/** The action's input as JSON Schema; parts Zod cannot express (transforms) become `{}`. */
export const inputSchema = (def: ActionDef): JsonSchema => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  return schema
}

function operation(def: ActionDef) {
  return {
    operationId: def.name,
    summary: def.description,
    tags: [def.name.split('.')[0]],
    'x-permission': def.permission,
    parameters: def.readOnly
      ? []
      : [{ name: 'idempotency-key', in: 'header', required: false, description: 'Any unique string; a retry with the same key returns the first result.', schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': { schema: inputSchema(def) } } },
    responses: {
      200: { description: 'Done.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } },
      401: errorResponse('Missing, unknown or revoked API key.'),
      403: errorResponse("The key's role lacks the permission."),
      409: errorResponse('Refused, for example the call does not exist in this workspace.'),
      422: errorResponse('The input does not match the schema.'),
      429: errorResponse('Rate limited; see the retry-after header.'),
    },
  }
}

const jsonSchema = (schema: z.ZodType): JsonSchema => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'output' }) as JsonSchema
  return rest
}

/** An assistant's webhook's three hooks, as OpenAPI 3.1 webhooks (docs/webhooks.md has signing and delivery). */
function webhooks() {
  const body = (schema: z.ZodType) => ({ required: true, content: { 'application/json': { schema: jsonSchema(schema) } } })
  return {
    call_start: {
      post: {
        summary: 'A call comes in: tell the assistant about the caller.',
        requestBody: body(callStartRequestSchema),
        responses: {
          200: {
            description: `Caller details within ${CALL_START_TIMEOUT_MS} ms; later, or anything else, and the call goes on without them.`,
            content: { 'application/json': { schema: jsonSchema(callStartReplySchema) } },
          },
        },
      },
    },
    during_call: {
      post: {
        summary: 'During a call: the assistant asks one of its lookups, e.g. an order status.',
        requestBody: body(duringCallRequestSchema),
        responses: {
          200: {
            description: `The answer within ${DURING_CALL_TIMEOUT_MS} ms; later, or anything else, and the assistant tells the caller it cannot check right now.`,
            content: { 'application/json': { schema: jsonSchema(duringCallReplySchema) } },
          },
        },
      },
    },
    call_finished: {
      post: {
        summary: `An integration's subscription (integration.subscribe): a finished phone call, about ${CALL_END_DELAY_SEC} s after it. Not signed; the subscribed URL is the secret.`,
        requestBody: body(integrationCallSchema),
        responses: {
          200: { description: 'Any 2xx answer within 10 seconds counts as delivered; 410 ends the subscription; anything else is tried again for about an hour.' },
        },
      },
    },
    call_end: {
      post: {
        summary: `A call ended: the whole call, about ${CALL_END_DELAY_SEC} s after it.`,
        requestBody: body(callEndPayloadSchema),
        responses: { 200: { description: 'Any 2xx answer within 10 seconds counts as delivered; anything else is tried again for about an hour.' } },
      },
    },
  }
}

const keyOnly = { 403: errorResponse('Not a workspace API key, or its role lacks call:read.'), 401: errorResponse('Missing, unknown or revoked API key.') }

/** The reads for integrations (apps/api/src/integration-routes.ts): API keys only. */
function integrationPaths() {
  const json = (schema: JsonSchema) => ({ content: { 'application/json': { schema } } })
  const list = (key: string, items: JsonSchema) =>
    json({ type: 'object', required: ['ok', key], properties: { ok: { const: true }, [key]: { type: 'array', items } } })
  return {
    '/v1/api-key': {
      get: {
        operationId: 'apiKey.me',
        summary: 'The API key in use and its workspace: a cheap test that a key works.',
        tags: ['integration'],
        responses: {
          200: {
            description: 'The key works.',
            ...json({
              type: 'object',
              properties: {
                ok: { const: true },
                workspace: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
                key: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, role: { enum: ['member', 'admin'] } } },
              },
            }),
          },
          ...keyOnly,
        },
      },
    },
    '/v1/integrations/calls': {
      get: {
        operationId: 'integration.calls',
        summary: 'The newest finished phone calls (no test calls, no spam), newest first, in the shape a call_finished subscription gets.',
        tags: ['integration'],
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: INTEGRATION_SAMPLE_CALLS_MAX, default: 3 } }],
        responses: { 200: { description: 'The calls.', ...list('calls', jsonSchema(integrationCallSchema)) }, ...keyOnly },
      },
    },
    '/v1/integrations/contacts': {
      get: {
        operationId: 'integration.contacts',
        summary: 'The contacts with this phone number.',
        tags: ['integration'],
        parameters: [
          { name: 'phone', in: 'query', required: true, description: 'E.164 (+15035550100), or a national number of `country`.', schema: { type: 'string' } },
          { name: 'country', in: 'query', required: false, description: 'ISO 3166-1 alpha-2 for a national number.', schema: { type: 'string', default: 'US' } },
        ],
        responses: {
          200: {
            description: 'The contacts, newest first (at most 10).',
            ...list('contacts', {
              type: 'object',
              properties: Object.fromEntries(['id', 'name', 'company', 'phone', 'email', 'address', 'note', 'blocked_at', 'created_at'].map(k => [k, { type: ['string', 'null'] }])),
            }),
          },
          422: errorResponse('Not a phone number.'),
          ...keyOnly,
        },
      },
    },
  }
}

export function openApiDocument(actions: Iterable<ActionDef>, serverUrl: string) {
  const published = [...actions].filter(a => a.public).sort((a, b) => a.name.localeCompare(b.name))
  return {
    openapi: '3.1.0',
    info: {
      title: 'Linedesk API',
      version: '1',
      description: 'Every write is an action: POST /v1/actions/<name> with a JSON body. Authenticate with a workspace API key (Workspace settings, Developers) as a Bearer token.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    paths: {
      ...Object.fromEntries(published.map(def => [`/v1/actions/${def.name}`, { post: operation(def) }])),
      ...integrationPaths(),
    } as Record<string, { post?: ReturnType<typeof operation>; get?: JsonSchema }>,
    webhooks: webhooks(),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A workspace API key: ld_…' } },
      schemas: { Result: ok, Rejection: rejection },
    },
  }
}
