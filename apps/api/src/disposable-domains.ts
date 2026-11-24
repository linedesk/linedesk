// Disposable-mail domains refused by self-serve sign-up before a code is sent. Not complete,
// and it need not be: it raises the cost of throwaway trials, while the card check and the trial limits bound what
// one costs. An install adds its own in `signup.rules` (`blockedDomains`).

/** Well-known throwaway-mail domains (lower case). A subdomain of one counts too. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  '33mail.com',
  'anonaddy.me',
  'burnermail.io',
  'byom.de',
  'mail.tm',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemail.net',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'grr.la',
  'harakirimail.com',
  'inboxkitten.com',
  'incognitomail.org',
  'jetable.org',
  'maildrop.cc',
  'mailcatch.com',
  'maildax.com',
  'mailinator.com',
  'mailinator.net',
  'mailinator2.com',
  'mailnesia.com',
  'mailpoof.com',
  'mailsac.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mytemp.email',
  'mytrashmail.com',
  'nada.email',
  'sharklasers.com',
  'spam4.me',
  'spambox.us',
  'spamgourmet.com',
  'spamex.com',
  'tempail.com',
  'tempinbox.com',
  'tempm.com',
  'tempmail.com',
  'tempmail.dev',
  'tempmail.net',
  'tempmail.plus',
  'tempmailo.com',
  'tempr.email',
  'temp-mail.io',
  'temp-mail.org',
  'throwawaymail.com',
  'trash-mail.com',
  'trashmail.com',
  'trashmail.de',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'emailfake.com',
  'fakemailgenerator.com',
  'mailnull.com',
  'discard.email',
  'tmail.ws',
  'tmpmail.org',
  'tmpmail.net',
  'minuteinbox.com',
  'luxusmail.org',
  'linshiyouxiang.net',
  'emailtemporanea.net',
  'crazymailing.com',
  'spamdecoy.net',
  'mvrht.net',
  'kurzepost.de',
  'wegwerfmail.de',
  'wegwerfmail.net',
  'einrot.com',
  'cuvox.de',
  'armyspy.com',
  'dayrep.com',
  'fleckens.hu',
  'gustr.com',
  'jourrapide.com',
  'rhyta.com',
  'superrito.com',
  'teleworm.us',
])

/** The domain of an address, lower case; null when it has none. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
}

/** Whether the address is at one of these domains or a subdomain of one. */
export function isBlockedDomain(email: string, extra: readonly string[] = []): boolean {
  const domain = domainOf(email)
  if (!domain) return true
  const blocked = (d: string) => DISPOSABLE_DOMAINS.has(d) || extra.some(e => e.toLowerCase() === d)
  const parts = domain.split('.')
  for (let i = 0; i < parts.length - 1; i++) if (blocked(parts.slice(i).join('.'))) return true
  return false
}
