/**
 * Keeps password managers out of a field: a key, another service's password, or someone else's name, email or
 * number. autocomplete="off" alone is ignored by 1Password, Bitwarden, LastPass and Dashlane, so each gets its own
 * attribute too.
 */
export const NO_PASSWORD_MANAGER = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const
