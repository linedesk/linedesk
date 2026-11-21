// Text that lost its letters on the way in. U+FFFD (the Unicode replacement character, shown as a question mark in a diamond) is what a decoder
// writes for bytes it could not read, and an AI agent sometimes sends it itself in place of a letter such as "ä".
// Stored, it stays broken for good: the assistant reads it aloud and every page shows it. So every action input that
// holds it anywhere (also deep in a list or an object such as `business_profile`) is refused with a clear error,
// on the server (run-action.ts) and in the browser before a command is queued (packages/sync store.ts).
import { msg } from '@linedesk/i18n'
import type { z } from 'zod'

export const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd)

/** The paths of the strings (and object keys) in `value` that hold U+FFFD; empty when the text is whole. */
export function brokenTextPaths(value: unknown, path: PropertyKey[] = [], out: PropertyKey[][] = []): PropertyKey[][] {
  if (typeof value === 'string') {
    if (value.includes(REPLACEMENT_CHARACTER)) out.push(path)
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => brokenTextPaths(item, [...path, i], out))
  } else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(REPLACEMENT_CHARACTER)) out.push([...path, key])
      else brokenTextPaths(item, [...path, key], out)
    }
  }
  return out
}

/** The Zod refinement: one issue per broken field (input-errors.ts turns it into "Recording notice: …"). */
export function refuseBrokenText(value: unknown, ctx: z.RefinementCtx) {
  for (const path of brokenTextPaths(value))
    ctx.addIssue({ code: 'custom', path, message: msg('server.input.brokenText') })
}

const guarded = new WeakMap<z.ZodType, z.ZodType>()

/**
 * An action's input schema with the refinement. Kept apart from `def.input` (and cached), so the schemas themselves
 * stay plain objects that the MCP servers can still `.extend()` and `.omit()`.
 */
export function guardedInput<S extends z.ZodType>(schema: S): S {
  let out = guarded.get(schema)
  if (!out) {
    out = schema.superRefine(refuseBrokenText)
    guarded.set(schema, out)
  }
  return out as S
}

/** Drops U+FFFD from every string, for text that comes from speech or a model and must not be refused mid-call. */
export function withoutBrokenText<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll(REPLACEMENT_CHARACTER, '') as T
  if (Array.isArray(value)) return value.map(withoutBrokenText) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replaceAll(REPLACEMENT_CHARACTER, ''), withoutBrokenText(v)]),
    ) as T
  return value
}
