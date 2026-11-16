// The words Linedesk adds to a call it sends to a connected app (app-pushes.ts): the heading of the next steps, the
// link back to the call, and the title when the call has none. In the workspace's language, like the summary.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import type { EmailLocale } from './templates.ts'

export function appPushText(locale: EmailLocale, caller: string) {
  const { t } = getT(locale)
  const brand = brandName()
  return {
    nextSteps: t('email.appPush.nextSteps'),
    openCall: t('email.appPush.openCall', { brand }),
    fallbackTitle: t('email.appPush.title', { brand, caller }),
  }
}
