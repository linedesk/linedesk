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
    call_end: {
      post: {
        summary: `A call ended: the whole call, about ${CALL_END_DELAY_SEC} s after it.`,
        requestBody: body(callEndPayloadSchema),
        responses: { 200: { description: 'Any 2xx answer within 10 seconds counts as delivered; anything else is tried again for about an hour.' } },
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
      description: 'Every write is an action: POST /v1/actions/<name> with a JSON body. Authenticate with a workspace API key (Settings, Developers) as a Bearer token.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    paths: Object.fromEntries(published.map(def => [`/v1/actions/${def.name}`, { post: operation(def) }])),
    webhooks: webhooks(),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A workspace API key: ld_…' } },
      schemas: { Result: ok, Rejection: rejection },
    },
  }
}
