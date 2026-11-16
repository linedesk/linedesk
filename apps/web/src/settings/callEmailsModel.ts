// The call email instruction as the editor shows it (Settings › Assistant › Call emails, CallEmails.tsx). The draft
// stores mentions as tokens (`<@user:ID>`, `<@email:ADDRESS>`, @linedesk/actions email-routing.ts); the text area
// shows them as `@Name` and `@address`, and every change is turned back into tokens. Pure, so it is tested alone.
import { emailMention, MENTION_PATTERN, userMention } from '@linedesk/actions'

/** Someone the instruction may name; `label` is what follows the @ in the text area. */
export type MentionPerson =
  | { kind: 'user'; id: string; label: string; email?: string; emailOn?: boolean; disabled?: boolean }
  | { kind: 'email'; email: string; label: string }

/** A mention found in the shown text: where it is and whom it names (null: a raw token of someone unknown). */
export type MentionRange = { start: number; end: number; person: MentionPerson | null }

/** One piece of the shown text for the highlight layer: plain text, or a mention. */
export type Piece = { text: string; mention?: { kind: 'user' | 'email' | 'unknown' } }

const RAW_TOKEN = /^<@(user|email):[^>\s]+>/
/** A character that continues a word or an address: an @ after one is part of an address, not a mention. */
const WORDISH = /[\p{L}\p{N}_.+-]/u
/** A character that would continue the name or address right after a mention's label. */
const CONTINUES = /[\p{L}\p{N}_@-]/u

const tokenOf = (p: MentionPerson) => (p.kind === 'user' ? userMention(p.id) : emailMention(p.email))
const keyOf = (p: MentionPerson) => (p.kind === 'user' ? `user:${p.id}` : `email:${p.email}`)

/**
 * The people to show and recognise: members (with a name made unique by their address when two share one), the
 * outside addresses, and every address the instruction names already (a removed one still reads as itself).
 */
export function mentionPeople(
  members: { userId: string; name: string; email?: string; emailOn?: boolean; disabled?: boolean }[],
  outside: string[],
  canonical: string,
  fallbackName: string,
): MentionPerson[] {
  const counts = new Map<string, number>()
  for (const m of members) {
    const name = m.name.trim() || fallbackName
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const people: MentionPerson[] = members.map(m => {
    const name = m.name.trim() || fallbackName
    const label = (counts.get(name) ?? 0) > 1 && m.email ? `${name} (${m.email})` : name
    return { kind: 'user', id: m.userId, label, email: m.email, emailOn: m.emailOn, disabled: m.disabled }
  })
  const emails = new Set(outside.map(e => e.toLowerCase()))
  for (const m of canonical.matchAll(MENTION_PATTERN)) if (m[1] === 'email') emails.add(m[2]!.toLowerCase())
  for (const email of emails) people.push({ kind: 'email', email, label: email })
  return people
}

/** The stored instruction as the text area shows it: tokens of known people become `@label`. */
export function toDisplay(canonical: string, people: MentionPerson[]): string {
  return canonical.replace(MENTION_PATTERN, (token, kind: string, value: string) => {
    const person = people.find(p =>
      kind === 'user' ? p.kind === 'user' && p.id === value : p.kind === 'email' && p.email === value.toLowerCase(),
    )
    return person ? `@${person.label}` : token
  })
}

/** Whether `display[i]` is an @ that starts a mention (not one inside an email address). */
const startsMention = (display: string, i: number) => display[i] === '@' && (i === 0 || !WORDISH.test(display[i - 1]!))

/** Whether a label that ends at `end` ends there for real (not "Dave" inside "Davey", not a shorter address). */
function endsAt(display: string, end: number): boolean {
  const next = display[end]
  if (next === undefined) return true
  if (CONTINUES.test(next)) return false
  // "@rosa@shop.example." ends the sentence; "@rosa@shop.example.com" is another address.
  return !(next === '.' && display[end + 1] !== undefined && /[\p{L}\p{N}]/u.test(display[end + 1]!))
}

/** The mentions in the shown text, in order: `@label` of a known person (the longest that fits) and raw tokens. */
export function mentionRanges(display: string, people: MentionPerson[]): MentionRange[] {
  const byLength = [...people].sort((a, b) => b.label.length - a.label.length)
  const ranges: MentionRange[] = []
  let i = 0
  while (i < display.length) {
    const raw = display[i] === '<' ? RAW_TOKEN.exec(display.slice(i)) : null
    if (raw) {
      ranges.push({ start: i, end: i + raw[0].length, person: null })
      i += raw[0].length
      continue
    }
    if (startsMention(display, i)) {
      const person = byLength.find(
        p => p.label && display.startsWith(p.label, i + 1) && endsAt(display, i + 1 + p.label.length),
      )
      if (person) {
        const end = i + 1 + person.label.length
        ranges.push({ start: i, end, person })
        i = end
        continue
      }
    }
    i++
  }
  return ranges
}

/** The shown text back as stored: every recognised `@label` becomes its token; raw tokens stay as they are. */
export function toCanonical(display: string, people: MentionPerson[]): string {
  let out = ''
  let at = 0
  for (const r of mentionRanges(display, people)) {
    if (!r.person) continue
    out += display.slice(at, r.start) + tokenOf(r.person)
    at = r.end
  }
  return out + display.slice(at)
}

/** The shown text in pieces for the highlight layer behind the text area. */
export function pieces(display: string, people: MentionPerson[]): Piece[] {
  const out: Piece[] = []
  let at = 0
  for (const r of mentionRanges(display, people)) {
    if (r.start > at) out.push({ text: display.slice(at, r.start) })
    out.push({ text: display.slice(r.start, r.end), mention: { kind: r.person?.kind ?? 'unknown' } })
    at = r.end
  }
  if (at < display.length) out.push({ text: display.slice(at) })
  return out
}

/**
 * The mention being typed at the caret: the @ it starts at and the words after it. null when the caret is not in one
 * (no @ before it on the line, the @ is inside an address, or the caret is inside a finished mention).
 */
export function mentionQuery(
  display: string,
  caret: number,
  people: MentionPerson[],
): { at: number; query: string } | null {
  for (let i = caret - 1; i >= 0 && caret - i <= 64; i--) {
    const c = display[i]!
    if (c === '\n') return null
    if (!startsMention(display, i)) continue
    const query = display.slice(i + 1, caret)
    if (/^\s|\s\s/.test(query)) return null
    // The @ starts a finished mention: no menu while the caret is inside it or right after it, and none after the space
    // a pick adds, unless a longer name still fits ("@Dave " on the way to "@Dave Ortiz").
    const done = mentionRanges(display, people).find(r => r.person && r.start === i)
    if (done) {
      const typed = query.toLowerCase()
      const longer = people.some(p => p.label.length > done.end - i - 1 && p.label.toLowerCase().startsWith(typed))
      if (done.end >= caret || !longer) return null
    }
    return { at: i, query }
  }
  return null
}

const MATCHES_MAX = 8

/** The people whose name or address has the typed words in them: those it starts with first, members first. */
export function matchPeople(query: string, people: MentionPerson[]): MentionPerson[] {
  const q = query.trim().toLowerCase()
  const fits = (p: MentionPerson) =>
    p.label.toLowerCase().includes(q) || (p.kind === 'user' && !!p.email?.toLowerCase().includes(q))
  const rank = (p: MentionPerson) => (p.label.toLowerCase().startsWith(q) ? 0 : 2) + (p.kind === 'user' ? 0 : 1)
  return people
    .filter(p => !(p.kind === 'user' && p.disabled) && fits(p))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    .slice(0, MATCHES_MAX)
}

/** An email address as typed, the way the server takes it (emailRecipient.add). */
export const looksLikeEmail = (text: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>.]{2,}$/.test(text.trim())

/** Whether the typed words are an address nobody on the list has: then the menu offers to add it. */
export const offersToAdd = (query: string, people: MentionPerson[]) =>
  looksLikeEmail(query) &&
  !people.some(p => (p.kind === 'email' ? p.email : p.email?.toLowerCase()) === query.trim().toLowerCase())

/** Puts `@label ` in place of the typed mention (from its @ to the caret); returns the text and the new caret. */
export function insertMention(
  display: string,
  at: number,
  caret: number,
  person: MentionPerson,
): { text: string; caret: number } {
  const after = display.slice(caret)
  const mention = `@${person.label}${/^[\s.,;:!?)]/.test(after) ? '' : ' '}`
  return { text: display.slice(0, at) + mention + after, caret: at + mention.length }
}

/** The people the instruction names, each once, in order; unknown ones left out. */
export function mentionedPeople(canonical: string, people: MentionPerson[]): MentionPerson[] {
  const seen = new Set<string>()
  const out: MentionPerson[] = []
  for (const m of canonical.matchAll(MENTION_PATTERN)) {
    const person = people.find(p =>
      m[1] === 'user' ? p.kind === 'user' && p.id === m[2] : p.kind === 'email' && p.email === m[2]!.toLowerCase(),
    )
    if (!person || seen.has(keyOf(person))) continue
    seen.add(keyOf(person))
    out.push(person)
  }
  return out
}
