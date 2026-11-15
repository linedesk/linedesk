/**
 * A person's UI language (docs/translations.md, "Levels"): `locale` is their choice (null: Automatic, follow the
 * browser), `localeAuto` what Automatic last resolved to in their browser, so emails know it. Fields of Better
 * Auth's `user` (set through updateUser like the name): only a UI language or null is stored.
 */
import { isUiLocale } from '@linedesk/i18n'
import { APIError } from 'better-auth/api'

export const userLocaleFields = {
  locale: { type: 'string', required: false, input: true },
  localeAuto: { type: 'string', required: false, input: true },
} as const

/** Refuses anything but a UI language or null in either field. */
export function checkLocaleFields(data: Record<string, unknown>) {
  for (const field of ['locale', 'localeAuto'] as const) {
    const value = data[field]
    if (value === undefined || value === null || isUiLocale(value)) continue
    throw new APIError('BAD_REQUEST', { message: `${field} must be one of the supported languages or empty` })
  }
}

const validate = async (data: Record<string, unknown>) => {
  checkLocaleFields(data)
  return undefined
}

/** Better Auth database hooks (merged in auth.ts). */
export const userLocaleHooks = {
  user: { create: { before: validate }, update: { before: validate } },
}
