// Turns a Linedesk action's fields (generated/actions.json, written from the registry by
// packages/actions/scripts/zapier.ts) into Zapier input fields, and what a Zap step filled in back into the action's
// input. Run Any Action does the same with the JSON Schema of /v1/openapi.json (fieldsFromSchema).

/** Zapier's type for ours: a day is picked like a time and cut to YYYY-MM-DD when sent. */
const ZAPIER_TYPE = {
  string: 'string',
  text: 'text',
  datetime: 'datetime',
  date: 'datetime',
  boolean: 'boolean',
  integer: 'integer',
  number: 'number',
}

/** A Zapier input field for one of ours; a key with a list (calls, contacts, …) gets its dropdown. */
function inputField(field) {
  const out = {
    key: field.key,
    label: field.label,
    type: field.json ? 'text' : (ZAPIER_TYPE[field.type] ?? 'string'),
    required: Boolean(field.required),
  }
  const help = [field.helpText, field.type === 'date' ? 'A day (YYYY-MM-DD).' : null, field.json ? 'As JSON.' : null].filter(Boolean).join(' ')
  if (help) out.helpText = help
  if (field.choices) out.choices = field.choices
  if (field.default !== undefined && typeof field.default !== 'object') out.default = String(field.default)
  if (field.dynamic) out.dynamic = `option_${field.dynamic}.id.label`
  if (field.children) {
    // Line items: Zapier allows no type next to children.
    delete out.type
    out.children = field.children.map(inputField)
  }
  return out
}

const snakeCase = key => key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
const isBlank = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/** One value as the action wants it; undefined leaves it out. */
function coerce(field, value) {
  if (field.children) {
    const rows = Array.isArray(value) ? value : []
    return rows.map(row => valuesOf(field.children, row ?? {})).filter(row => Object.keys(row).length > 0)
  }
  if (isBlank(value)) return field.nullable && field.required ? null : undefined
  if (field.json) {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      throw new Error(`${field.label}: JSON, e.g. ["a", "b"] or {"key": "value"}`)
    }
  }
  switch (field.type) {
    case 'boolean':
      return value === true || /^(true|yes|1|on)$/i.test(String(value).trim())
    case 'integer':
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(`${field.label}: a number, not "${value}"`)
      return field.type === 'integer' ? Math.trunc(n) : n
    }
    case 'date':
      return String(value).trim().slice(0, 10)
    case 'datetime':
      return new Date(String(value).trim()).toISOString()
    default:
      return field.phone ? String(value).replace(/[^\d+]/g, '') : String(value).trim()
  }
}

/** The action's input from what the step filled in: blank fields are left out. */
function valuesOf(fields, inputData) {
  const input = {}
  for (const field of fields) {
    // call_id for callId: the names of the first version's fields, so Zaps made with it keep working.
    const given = inputData[field.key] ?? inputData[snakeCase(field.key)]
    const value = coerce(field, given)
    if (value !== undefined) input[field.key] = value
  }
  return input
}

/** Our fields from an action's JSON Schema (the install's /v1/openapi.json): for Run Any Action. */
function fieldsFromSchema(schema) {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {})
    .filter(([, prop]) => prop.const === undefined)
    .map(([key, raw]) => {
      const branches = raw.anyOf ? raw.anyOf.filter(s => s.type !== 'null') : null
      const prop = branches && branches.length === 1 ? { ...branches[0], description: raw.description } : raw
      const types = Array.isArray(prop.type) ? prop.type.filter(t => t !== 'null') : [prop.type]
      const type = types[0]
      const nullable = (raw.anyOf ?? []).some(s => s.type === 'null') || (Array.isArray(raw.type) && raw.type.includes('null'))
      const field = {
        key,
        label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()),
        type:
          type === 'boolean' || type === 'integer' || type === 'number'
            ? type
            : prop.format === 'date-time'
              ? 'datetime'
              : prop.format === 'date'
                ? 'date'
                : 'string',
        required: required.has(key),
      }
      if (nullable) field.nullable = true
      if (prop.description) field.helpText = prop.description
      if (prop.enum) field.choices = prop.enum.map(String)
      if (type === 'array' && prop.items?.type === 'object') field.children = fieldsFromSchema(prop.items)
      else if (type === 'array' || type === 'object') field.json = true
      return field
    })
}

module.exports = { inputField, valuesOf, fieldsFromSchema }
