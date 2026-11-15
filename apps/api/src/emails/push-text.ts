// What a push notification says (push.ts sends it): its title and its one line, in the recipient's language. Who
// called and what about stay as they were written (a contact's name, the call's title in the workspace's language).
import { getT } from '@linedesk/i18n/server'
import type { EmailLocale } from './templates.ts'

/** "Urgent call from Priya Shah", "Message from …", "New call from …". */
export const callPushTitle = (kind: 'urgent' | 'message' | 'finished', who: string, locale: EmailLocale) =>
  getT(locale).t('email.push.title', { kind, who })

/** "Mike assigned you a call" and "From Priya Shah · Leaking water heater". */
export function assignedPushText(by: string, who: string, about: string | null, locale: EmailLocale) {
  const { t } = getT(locale)
  return {
    title: t('email.push.assignedTitle', { by }),
    body: t('email.push.assignedBody', { who, about: about ?? '', hasAbout: about ? 'yes' : 'no' }),
  }
}
