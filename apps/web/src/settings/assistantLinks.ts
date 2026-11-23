// Links into the assistant's settings: `#assistant/<id>/<section>[/<item>]`. Old and short links are rewritten in
// place (AssistantSettings), so bookmarks, emails and docs from before a regrouping still land in the right place.

/** The webhook's place in Advanced: `#assistant/<id>/advanced/webhook` scrolls to it. */
export const WEBHOOK_ITEM = 'webhook'

/** Section ids from before the regrouping, and the section each is part of now. */
export const OLD_SECTIONS: Record<string, string> = {
  greeting: 'general',
  knowledge: 'business',
  transfer: 'transfers',
  calls: 'transfers',
  calendar: 'booking',
  emergencies: 'transfers',
  voice: 'general',
  // The webhook was a section of its own until it moved into Advanced (2026-11-18).
  webhooks: 'advanced',
}

/**
 * Where an old or short link belongs, or null when it is already right: `#assistant/<section>` (no assistant) goes
 * to the first assistant, a section id from before the regrouping to its new one, the old Webhook section to the
 * webhook in Advanced, and the assistant's notifications to Account settings › Preferences.
 */
export function canonicalAssistantHash(hash: string, assistantIds: readonly string[]): string | null {
  const [path = '', query] = hash.replace(/^#/, '').split('?')
  const [page, ...parts] = path.split('/')
  if (page !== 'assistant' || !parts.length) return null
  const isAssistant = assistantIds.includes(parts[0]!)
  const id = isAssistant ? parts[0]! : assistantIds[0]
  const section = isAssistant ? parts[1] : parts[0]
  if (!id || !section) return null
  const tail = query ? `?${query}` : ''
  // Notifications are your own settings now (Account settings › Preferences), not the assistant's.
  if (section === 'notifications') return `#account/preferences${tail}`
  const next = OLD_SECTIONS[section] ?? section
  if (isAssistant && next === section) return null
  const below = section === 'webhooks' ? [WEBHOOK_ITEM] : parts.slice(isAssistant ? 2 : 1)
  return `#assistant/${[id, next, ...below].join('/')}${tail}`
}
