// The few pages the server shows on its own, outside the web app: what a link in an email opens (setup-unsubscribe.ts).
// Plain HTML in the reader's language; the CSP allows no inline styles or scripts, and none are needed.
import { getT } from '@linedesk/i18n/server'
import { emailBrandName } from '../email-brand.ts'
import type { EmailLocale } from './templates.ts'

const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function page(lang: string, title: string, body: string) {
  return `<!doctype html><html lang="${htmlEscape(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEscape(title)}</title></head><body><main><h1>${htmlEscape(title)}</h1>${body}</main></body></html>`
}

const paragraph = (text: string) => `<p>${htmlEscape(text)}</p>`

/**
 * The setup emails' unsubscribe link: `invalid` (a bad token), `confirm` (the page with the button, so a link scanner
 * that opens it unsubscribes nobody; `action` is where the button posts) and `done`.
 */
export function setupUnsubscribePage(kind: 'invalid' | 'confirm' | 'done', locale: EmailLocale, action = ''): string {
  const { t, locale: lang } = getT(locale)
  if (kind === 'invalid')
    return page(lang, t('email.unsubscribe.invalidTitle'), paragraph(t('email.unsubscribe.invalidText')))
  if (kind === 'done') return page(lang, t('email.unsubscribe.doneTitle'), paragraph(t('email.unsubscribe.doneText')))
  return page(
    lang,
    t('email.unsubscribe.confirmTitle'),
    `${paragraph(t('email.unsubscribe.confirmText', { brand: emailBrandName() }))}<form method="post" action="${htmlEscape(action)}"><button type="submit">${htmlEscape(t('email.unsubscribe.confirmButton'))}</button></form>`,
  )
}
