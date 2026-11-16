// The deterministic checks of the LLM test suite (LIN-391): what a transcript must or must not hold, without a model.
// Each returns null when it passes, else a short reason for the report.
import type { CallEvent, Transcript } from './conversation.ts'

/** Which caller turns' replies a check looks at: all (default), one turn, or from a turn on. */
export type TurnScope = number | 'all' | { from: number }

export type Check =
  /** The tool is called (at least once); `args`: each named argument matches its pattern; `byTurn`: no later than that turn. */
  | { type: 'tool'; tool: string; args?: Record<string, RegExp>; byTurn?: number }
  /** Some call of the tool returned a result that matches (for example the booked time). */
  | { type: 'toolResult'; tool: string; pattern: RegExp }
  /** None of these tools is ever called. */
  | { type: 'noTool'; tool: string | string[] }
  /** The first tool the assistant calls on the call is this one. */
  | { type: 'firstTool'; tool: string }
  /** `tool` is not called before `before` is (or at all, if `before` never is). */
  | { type: 'notBefore'; tool: string; before: string }
  /** Some reply in scope matches. */
  | { type: 'say'; pattern: RegExp; turn?: TurnScope }
  /** No reply in scope matches. */
  | { type: 'notSay'; pattern: RegExp; turn?: TurnScope }
  /** Every reply in scope is in this language (a word-count heuristic). */
  | { type: 'language'; lang: 'en' | 'de' | 'es' | 'fr'; turn?: TurnScope }
  /** Every reply in scope has at most this many sentences. */
  | { type: 'maxSentences'; max: number; turn?: TurnScope }
  /** The call ended (end_call hung up, or the transfer connected), or did not. */
  | { type: 'ended'; value: boolean }
  /** The call is flagged as urgent (flag_urgent, or the worker's guard on "I flagged it"), or not. */
  | { type: 'urgent'; value: boolean }

const inScope = (turn: number, scope: TurnScope = 'all') =>
  turn > 0 && (scope === 'all' ? true : typeof scope === 'number' ? turn === scope : turn >= scope.from)

type Said = Extract<CallEvent, { kind: 'assistant' }>
type ToolEvent = Extract<CallEvent, { kind: 'tool' }>

/** What the assistant said in its own words (not the fixed lines), in scope. */
export const repliesIn = (t: Transcript, scope?: TurnScope): Said[] =>
  t.events.filter((e): e is Said => e.kind === 'assistant' && inScope(e.turn, scope))

export const toolsOf = (t: Transcript): ToolEvent[] => t.events.filter((e): e is ToolEvent => e.kind === 'tool')

const quote = (text: string) => `"${text.length > 160 ? `${text.slice(0, 157)}...` : text}"`

/** Sentences of a spoken reply; "a.m.", "Mr." and times do not end one. */
export function sentencesOf(text: string): string[] {
  const cleaned = text.replace(/\b(?:Mr|Mrs|Ms|Dr|St|Ave|approx|e\.g|i\.e|a\.m|p\.m)\./gi, m => m.replace(/\./g, ''))
  return cleaned
    .split(/(?<=[.!?¿¡…])\s+/)
    .map(s => s.trim())
    .filter(s => /[\p{L}\p{N}]/u.test(s))
}

const STOPWORDS: Record<'en' | 'de' | 'es' | 'fr', string[]> = {
  en: [
    'the',
    'you',
    'and',
    'to',
    'is',
    'can',
    'i',
    'a',
    'your',
    'for',
    'with',
    'it',
    'that',
    'this',
    'please',
    'help',
    'will',
    'of',
    'we',
    'are',
    'in',
    'what',
    'how',
    'thanks',
    'only',
    'message',
    'my',
    'me',
    'have',
    'there',
    'be',
  ],
  de: [
    'ich',
    'sie',
    'und',
    'der',
    'die',
    'das',
    'ist',
    'nicht',
    'ein',
    'eine',
    'zu',
    'mit',
    'für',
    'auf',
    'kann',
    'ihnen',
    'wir',
    'es',
    'gerne',
    'bitte',
    'nur',
    'nachricht',
    'wie',
    'was',
    'ihre',
    'ihr',
    'den',
    'dem',
    'haben',
    'können',
    'leider',
    'auch',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'que',
    'de',
    'y',
    'en',
    'un',
    'una',
    'por',
    'para',
    'con',
    'puedo',
    'usted',
    'su',
    'es',
    'no',
    'mensaje',
    'solo',
    'ayudar',
    'lo',
    'le',
    'se',
    'cómo',
    'qué',
    'gracias',
    'favor',
    'al',
    'del',
    'está',
    'sí',
  ],
  fr: [
    'le',
    'la',
    'les',
    'je',
    'vous',
    'et',
    'de',
    'un',
    'une',
    'est',
    'pour',
    'avec',
    'que',
    'pas',
    'ne',
    'votre',
    'message',
    'seulement',
    'peux',
    'des',
    'du',
    'au',
    'merci',
    'bien',
    'il',
    'nous',
    'en',
    'qui',
  ],
}

/** The language of a reply by its common words; null when too short to tell. */
export function languageOf(text: string): 'en' | 'de' | 'es' | 'fr' | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? []
  if (words.length < 3) return null
  const scores = (Object.keys(STOPWORDS) as (keyof typeof STOPWORDS)[]).map(
    lang => [lang, words.filter(w => STOPWORDS[lang].includes(w)).length] as const,
  )
  scores.sort((a, b) => b[1] - a[1])
  const [best, second] = scores
  if (!best || best[1] === 0 || (second && best[1] === second[1])) return null
  return best[0]
}

const MARKDOWN = /(\*\*|__|^#{1,6}\s|^\s*[-*•]\s|^\s*\d+[.)]\s|`)/m
const EMOJI = /\p{Extended_Pictographic}/u

export function runCheck(check: Check, t: Transcript): string | null {
  const tools = toolsOf(t)
  switch (check.type) {
    case 'tool': {
      const calls = tools.filter(c => c.name === check.tool && (check.byTurn === undefined || c.turn <= check.byTurn))
      if (!calls.length)
        return `${check.tool} not called${check.byTurn !== undefined ? ` by turn ${check.byTurn}` : ''} (tools: ${tools.map(c => c.name).join(', ') || 'none'})`
      if (!check.args) return null
      const fits = calls.some(c =>
        Object.entries(check.args!).every(([k, re]) =>
          re.test(typeof c.args[k] === 'string' ? (c.args[k] as string) : JSON.stringify(c.args[k] ?? '')),
        ),
      )
      return fits
        ? null
        : `${check.tool} called, but not with ${Object.entries(check.args)
            .map(([k, re]) => `${k} ~ ${re}`)
            .join(', ')} (got ${calls.map(c => c.raw).join(' | ')})`
    }
    case 'toolResult': {
      const calls = tools.filter(c => c.name === check.tool)
      if (!calls.length) return `${check.tool} not called`
      return calls.some(c => check.pattern.test(c.result))
        ? null
        : `${check.tool} result does not match ${check.pattern} (got ${calls.map(c => quote(c.result)).join(' | ')})`
    }
    case 'noTool': {
      const names = Array.isArray(check.tool) ? check.tool : [check.tool]
      const hit = tools.find(c => names.includes(c.name))
      return hit ? `${hit.name} called at turn ${hit.turn} (${hit.raw || '{}'})` : null
    }
    case 'firstTool': {
      const first = tools[0]
      return first?.name === check.tool ? null : `first tool was ${first?.name ?? 'none'}, not ${check.tool}`
    }
    case 'notBefore': {
      const at = tools.findIndex(c => c.name === check.before)
      const early = tools.findIndex(c => c.name === check.tool)
      if (early < 0) return null
      return at < 0 || early < at
        ? `${check.tool} called before ${check.before}${at < 0 ? ` (${check.before} never called)` : ''}`
        : null
    }
    case 'say': {
      const replies = repliesIn(t, check.turn)
      return replies.some(r => check.pattern.test(r.text))
        ? null
        : `no reply matches ${check.pattern} (replies: ${replies.map(r => quote(r.text)).join(' / ') || 'none'})`
    }
    case 'notSay': {
      const hit = repliesIn(t, check.turn).find(r => check.pattern.test(r.text))
      return hit ? `turn ${hit.turn} matches ${check.pattern}: ${quote(hit.text)}` : null
    }
    case 'language': {
      const replies = repliesIn(t, check.turn)
      if (!replies.length) return `no reply to check the language of`
      const wrong = replies.find(r => {
        const lang = languageOf(r.text)
        return lang !== null && lang !== check.lang
      })
      return wrong
        ? `turn ${wrong.turn} is in ${languageOf(wrong.text)}, not ${check.lang}: ${quote(wrong.text)}`
        : null
    }
    case 'maxSentences': {
      const long = repliesIn(t, check.turn).find(r => sentencesOf(r.text).length > check.max)
      return long
        ? `turn ${long.turn} has ${sentencesOf(long.text).length} sentences (max ${check.max}): ${quote(long.text)}`
        : null
    }
    case 'ended':
      return t.ended === check.value ? null : check.value ? 'the call did not end' : `the call ended (${t.endedBy})`
    case 'urgent':
      return t.urgent === check.value ? null : check.value ? 'not flagged as urgent' : 'flagged as urgent'
  }
}

/** Checked on every call: hard rules of the prompt and the tools whatever the case. */
export function globalProblems(t: Transcript): string[] {
  const problems: string[] = []
  for (const r of repliesIn(t)) {
    if (MARKDOWN.test(r.text)) problems.push(`markdown or a list in a spoken reply: ${quote(r.text)}`)
    if (EMOJI.test(r.text)) problems.push(`emoji in a spoken reply: ${quote(r.text)}`)
  }
  const byResponse = new Map<number, string[]>()
  for (const c of toolsOf(t)) byResponse.set(c.response, [...(byResponse.get(c.response) ?? []), c.name])
  for (const names of byResponse.values())
    if (names.includes('end_call') && names.length > 1)
      problems.push(`end_call in the same response as ${names.filter(n => n !== 'end_call').join(', ')}`)
  for (const c of toolsOf(t)) if (c.error) problems.push(`tool call refused: ${c.name}: ${c.result.slice(0, 160)}`)
  return problems
}

/** A check as text, for the report. */
export const describeCheck = (check: Check): string =>
  JSON.stringify(check, (_k, v) => (v instanceof RegExp ? String(v) : v))
