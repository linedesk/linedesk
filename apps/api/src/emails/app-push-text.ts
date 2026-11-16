// The words Linedesk adds to a call it sends to a connected app (app-pushes.ts): the heading of the next steps, the
// link back to the call, the title when the call has none, and for Slack's message the caller and number labels, the
// urgent flag and when the call was. In the workspace's language, like the summary.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import type { EmailLocale } from './templates.ts'

export function appPushText(locale: EmailLocale, caller: string, startedAt?: string | Date) {
  const { t, format } = getT(locale)
  const brand = brandName()
  return {
    nextSteps: t('email.appPush.nextSteps'),
    openCall: t('email.appPush.openCall', { brand }),
    fallbackTitle: t('email.appPush.title', { brand, caller }),
    caller: t('email.appPush.caller'),
    number: t('email.appPush.number'),
    urgent: t('email.appPush.urgent'),
    // Slack shows the time in each reader's own zone; this is its fallback, in UTC.
    when: startedAt
      ? `${format.dateTime(new Date(startedAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
      : '',
  }
}
