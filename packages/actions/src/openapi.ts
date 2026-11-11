// The public API as an OpenAPI 3.1 document, generated from the registry: one path per action
// marked `public`, its input schema straight from the action's Zod schema.
import { z } from 'zod'
import type { ActionDef } from './define.ts'

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
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A workspace API key: ld_…' } },
      schemas: { Result: ok, Rejection: rejection },
    },
  }
}
