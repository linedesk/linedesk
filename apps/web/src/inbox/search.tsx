// Search (/) covers every call: caller, number, title, summary and transcript text.
import type { Call, Contact, TranscriptSegment } from '@linedesk/db/types'
import type { ReactNode } from 'react'
import { callTitle, formatPhone } from '../inbox-model.ts'

export type SearchHit = { field: string; text: string; atMs?: number }

type Searchable = { call: Call; contact?: Contact; segments: TranscriptSegment[]; assistantName: string }

function speakerName(s: TranscriptSegment, callerLabel: string, assistantName: string): string {
  return s.speaker === 'caller' ? callerLabel : s.speaker === 'agent' ? assistantName : s.speaker === 'human' ? 'Team' : 'Event'
}

function textsOf({ call, contact, segments, assistantName }: Searchable): SearchHit[] {
  const caller = contact?.name || formatPhone(call.from_number)
  return [
    { field: 'Summary', text: call.summary ?? '' },
    { field: 'Topic', text: callTitle(call) },
    ...segments.map(s => ({ field: speakerName(s, caller, assistantName), text: s.text, atMs: s.at_ms })),
  ]
}

const has = (text: string, q: string) => text.toLowerCase().includes(q)
const normalize = (query: string) => query.trim().toLowerCase()
const wordsOf = (query: string) => normalize(query).split(/\s+/).filter(Boolean)
const digitsOf = (text: string) => text.replace(/\D/g, '')

/** The digits of a query written like a phone number ("(503) 555-0100"), or null for any other query. */
function phoneDigits(query: string): string | null {
  const digits = digitsOf(query)
  return /^[\d\s()+.-]+$/.test(query.trim()) && digits.length >= 3 ? digits : null
}

/** Where the query appears in the call's content: the whole query first, else the first of its words; null if nowhere. */
export function searchHit(item: Searchable, query: string): SearchHit | null {
  const texts = textsOf(item)
  const q = normalize(query)
  return texts.find(t => has(t.text, q)) ?? texts.find(t => wordsOf(query).some(w => has(t.text, w))) ?? null
}

/** A call matches when the query is its number (any punctuation), or every word of the query appears somewhere in it, in any order. */
export function matchesSearch(item: Searchable, query: string): boolean {
  const { call, contact } = item
  const phone = phoneDigits(query)
  if (phone && digitsOf(call.from_number).includes(phone)) return true
  const everything = [contact?.name, contact?.company, call.from_number, formatPhone(call.from_number), ...textsOf(item).map(t => t.text)].filter(Boolean).join('\n').toLowerCase()
  return wordsOf(query).every(word => everything.includes(word))
}

/** What to mark in a text: the whole query if it is there, else the first of its words that is. */
function termIn(text: string, query: string): string | null {
  const lower = text.toLowerCase()
  return [normalize(query), ...wordsOf(query)].find(term => term && lower.includes(term)) ?? null
}

/** Wrap the first match in <mark>; with `max`, trim the text around the match. */
export function highlight(text: string, query: string | null, max?: number): ReactNode {
  const clip = (t: string) => (max && t.length > max ? `${t.slice(0, max)}…` : t)
  const q = query ? termIn(text, query) : null
  if (!q) return clip(text)
  const i = text.toLowerCase().indexOf(q)
  const from = max && text.length > max ? Math.max(0, i - Math.round(max * 0.3)) : 0
  const to = max && text.length > max ? Math.min(text.length, from + max) : text.length
  return <>{from > 0 ? '…' : ''}{text.slice(from, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length, to)}{to < text.length ? '…' : ''}</>
}
