// What the after-call transcription model is told before it hears a call (after-call-transcript.ts): names it
// cannot know (the business, the assistant, the caller as the team saved them, the appointment types) as key terms,
// and the language when the assistant speaks only one. Only names, never a sentence: each provider treats them as
// words it may hear, not as text it must write. A name the caller gave is left out: it came from the live transcript
// and may be what the live model misheard.
import { mainLanguageOf, otherLanguagesOf } from '@linedesk/actions'
import { appointment_types, assistants, calls, contacts, organization, type Tx } from '@linedesk/db'
import { and, asc, eq } from 'drizzle-orm'
import { workspaceLocale } from './workspace-locale.ts'

export type TranscribeHints = {
  /** Names the call may contain, most important first; each clean for every provider (cleanTerms). */
  terms: string[]
  /** ISO 639-1; null: the model detects it (the assistant speaks more than one). */
  language: string | null
}

export const NO_HINTS: TranscribeHints = { terms: [], language: null }

/** At most this many terms: providers take 100 to 1000, but recommend few; a call has few names. */
export const MAX_TERMS = 20
/** The strictest provider's limits (ElevenLabs): 50 characters, 5 words. */
const MAX_TERM_CHARS = 50
const MAX_TERM_WORDS = 5
/** Refused by a provider inside a term (OpenAI: <, >, CR, LF; ElevenLabs: <>{}[]\), and control characters. */
const REFUSED = /[<>{}[\]\\\p{Cc}]/gu

/** Trimmed, spaces collapsed, refused characters removed; too long, empty or repeated (any case) terms dropped. */
export function cleanTerms(raw: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const value of raw) {
    const term = (value ?? '').replace(REFUSED, ' ').replace(/\s+/g, ' ').trim()
    if (!term || term.length > MAX_TERM_CHARS || term.split(' ').length > MAX_TERM_WORDS) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length === MAX_TERMS) break
  }
  return terms
}

/** The hints for one call. */
export async function transcriptHints(tx: Tx, callId: string): Promise<TranscribeHints> {
  const [call] = await tx
    .select({
      workspace: organization.name,
      workspaceId: calls.workspace_id,
      assistant: assistants.name,
      languages: assistants.languages,
      contact: contacts.name,
      contactSource: contacts.name_source,
      company: contacts.company,
    })
    .from(calls)
    .innerJoin(organization, eq(organization.id, calls.workspace_id))
    .leftJoin(assistants, eq(assistants.id, calls.assistant_id))
    .leftJoin(contacts, eq(contacts.id, calls.contact_id))
    .where(eq(calls.id, callId))
  if (!call) return NO_HINTS
  const types = await tx
    .select({ name: appointment_types.name })
    .from(appointment_types)
    .where(and(eq(appointment_types.workspace_id, call.workspaceId), eq(appointment_types.enabled, true)))
    .orderBy(asc(appointment_types.name))
  const fallback = (await workspaceLocale(tx, call.workspaceId)).resolvedLanguage
  const onlyOne = call.languages !== null && !otherLanguagesOf(call.languages, fallback).length
  return {
    terms: cleanTerms([
      call.workspace,
      call.assistant,
      call.contactSource === 'member' ? call.contact : null,
      call.contactSource === 'member' ? call.company : null,
      ...types.map(t => t.name),
    ]),
    language: onlyOne ? mainLanguageOf(call.languages, fallback) : null,
  }
}
