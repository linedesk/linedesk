// Before support mail goes to a language model (the support mail analysis, LIN-642), the personal data of the
// business's customers comes out: email addresses, phone numbers, links, street addresses, card-like numbers and the
// names of the people writing. What is left is enough to learn what customers ask and how support answers.

/** The text above a reply's quote of the earlier mail ("On Tue, Jane wrote:", "-----Original Message-----", "> …"). */
export function stripQuoted(text: string): string {
  const lines = text.split('\n')
  const cut = lines.findIndex(
    line =>
      /^\s*On .{3,200}wrote:\s*$/i.test(line) ||
      /^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line) ||
      /^\s*(From|Von):\s.+/i.test(line) ||
      /^\s*_{10,}\s*$/.test(line),
  )
  return (cut === -1 ? lines : lines.slice(0, cut))
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi
// Card and account numbers: 12 or more digits, spaces or dashes between groups allowed.
const LONG_NUMBER = /\b\d(?:[ -]?\d){11,}\b/g
// North American and international phone numbers: +, groups of digits, brackets, dots, spaces or dashes; 7+ digits.
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,3}\b/g
// "412 Oak St", "18 Main Street": a house number and a street word.
const STREET =
  /\b\d{1,6}\s+(?:[A-Z][\w'.-]*\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Hwy|Highway|Pkwy|Parkway)\b\.?/g
// "Hi Jane," "Dear Mr. Porter," "Thanks, Jane" at the start or end of a mail.
const GREETING = /^(\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b)[^,\n!]{1,40}([,!])/gim
// Case-sensitive on purpose (\p{Lu} under the `i` flag would take any word as a name), so both spellings.
const CLOSING = String.raw`(?:[Tt]hanks|[Tt]hank you|[Mm]any thanks|[Rr]egards|[Bb]est|[Cc]heers|[Ss]incerely|[Bb]est regards|[Kk]ind regards)`
const NAME = String.raw`\p{Lu}[\p{L}'-]*(?:[ \t]+\p{Lu}[\p{L}'-]*)?`
// "Thanks, Jane" on one line, or "Best regards," with the name on the next.
const SIGN_OFF = new RegExp(String.raw`^([ \t]*${CLOSING}[,!.]?(?:[ \t]+|[ \t]*\n[ \t]*))${NAME}[ \t]*$`, 'gmu')

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Names of a header value ("Jane Porter <jane@example.com>" → Jane, Porter); words of 2+ letters. */
export function namesOf(header: string): string[] {
  const display = header.replace(/<[^>]*>/g, '').replace(/["']/g, '')
  return display
    .split(/[\s,]+/)
    .map(w => w.trim())
    .filter(w => /^\p{L}[\p{L}'-]+$/u.test(w) && !w.includes('@'))
}

/**
 * The text without personal data: addresses, numbers and links replaced by a placeholder, greetings and sign-offs
 * without the name, and each of `names` (the people in the conversation) replaced wherever it stands.
 */
export function redactPersonal(text: string, names: readonly string[] = []): string {
  let out = text
    .replace(EMAIL, '[email]')
    .replace(URL_RE, '[link]')
    .replace(LONG_NUMBER, '[number]')
    .replace(STREET, '[address]')
    .replace(PHONE, match => (match.replace(/\D/g, '').length >= 7 ? '[phone]' : match))
    .replace(GREETING, '$1 [name]$2')
    .replace(SIGN_OFF, '$1[name]')
  for (const name of new Set(names.filter(n => n.length >= 2))) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'giu'), '[name]')
  }
  return out
}
