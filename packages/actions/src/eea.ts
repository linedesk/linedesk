// The countries where EU-style call rules apply to a workspace: the EU and EEA (EU AI Act Art. 50(1), GDPR) and the
// United Kingdom (UK GDPR; recommended in the legal review of 2026-11-17, LIN-419). The one list the settings' law
// warnings read (AI disclosure, recording notice and retention); nothing is refused by it: the owner decides.

/** The 27 EU countries, the other EEA countries (Iceland, Liechtenstein, Norway) and the United Kingdom. */
export const EEA_UK_COUNTRIES = [
  ...['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE'],
  ...['IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'],
  ...['IS', 'LI', 'NO'],
  'GB',
] as const

const EEA_UK: ReadonlySet<string> = new Set(EEA_UK_COUNTRIES)

/** Whether a workspace country (ISO 3166-1 alpha-2, resolveWorkspaceCountry) is in the EEA or the UK. */
export const inEeaOrUk = (country: string | null | undefined): boolean =>
  !!country && EEA_UK.has(country.trim().toUpperCase())
