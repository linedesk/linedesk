// Business info as parts (LIN-724): the About text the assistant reads stays one text (business_profile.instructions),
// but the page shows it as the business's own text and a list of questions and answers. Every
// `If a caller asks "…": …` line (an answered open question, answeredQuestionLine; an accepted support mail topic,
// mailTopicLine) is one row; all other lines are the business text. Writing back keeps every row the page did not
// change as it was, so a text that was not edited stays byte for byte.
import { answeredQuestionLine } from '@linedesk/actions'

/** Where a row came from, as far as its line tells: a support mail topic adds what to ask the caller for. */
export type AboutSource = 'mail' | 'answered'

export type AboutQuestion = {
  /** Stable while the page is open. */
  key: string
  question: string
  /** Everything the assistant says or does for it, "To help, ask the caller for: …" included. */
  answer: string
  source: AboutSource
  /** The line as read; null for a row added on the page. */
  line: string | null
}

export type AboutParts = { profile: string; questions: AboutQuestion[] }

const QUESTION_LINE = /^If a caller asks "(.+?)": (.+)$/
// i18n-ignore: the marker mailTopicLine writes (text the assistant reads), not UI
const MAIL_MARK = ' To help, ask the caller for: '

function parseLine(line: string): Pick<AboutQuestion, 'question' | 'answer' | 'source'> | null {
  const m = QUESTION_LINE.exec(line.trim())
  if (!m) return null
  return { question: m[1]!, answer: m[2]!.trim(), source: m[2]!.includes(MAIL_MARK) ? 'mail' : 'answered' }
}

/** The About text as the business's own text and its question rows, in the order they appear. */
export function parseAbout(text: string): AboutParts {
  const profile: string[] = []
  const questions: AboutQuestion[] = []
  text.split('\n').forEach((line, i) => {
    const q = parseLine(line)
    // Keyed by its place among the rows: edits to the business text above do not change it (keyAfter).
    if (q) questions.push({ ...q, key: `q${questions.length}`, line })
    else profile.push(line)
  })
  return {
    profile: profile
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    questions,
  }
}

/** One row as the line the assistant reads: a row the page did not change keeps its line. */
export function questionLine(q: Pick<AboutQuestion, 'question' | 'answer' | 'line'>): string {
  const read = q.line ? parseLine(q.line) : null
  if (q.line && read && read.question === q.question && read.answer === q.answer.trim()) return q.line
  return answeredQuestionLine(q.question, q.answer)
}

/** The parts back as one About text: the business text, then one line per question (empty rows left out). */
export function joinAbout(parts: AboutParts): string {
  const lines = parts.questions.filter(written).map(questionLine)
  return [parts.profile.trim(), lines.join('\n')].filter(Boolean).join('\n')
}

/** Whether a row is written into the text (it has a question and an answer). */
export const written = (q: Pick<AboutQuestion, 'question' | 'answer'>) => !!(q.question.trim() && q.answer.trim())

/**
 * The key a row has once `next` is written and read back: a written row's place among the written rows, so a panel
 * stays on its row when an earlier row is merged away or a new row gets its answer; a row not written keeps its key.
 */
export function keyAfter(next: AboutParts, key: string): string {
  const row = next.questions.find(q => q.key === key)
  if (!row) return key
  if (!written(row)) return draftKey(key)
  return `q${next.questions.filter(written).indexOf(row)}`
}

/** A read row that is no longer written (its answer cleared) keeps a key no read row can have. */
export const draftKey = (key: string) => (key.startsWith('q') ? `d${key}` : key)

/** A new, empty row; it is written only once it has a question and an answer. */
export const newQuestion = (n: number): AboutQuestion => ({
  key: `new${n}`,
  question: '',
  answer: '',
  source: 'answered',
  line: null,
})

// --- Health check ---------------------------------------------------------------------------

export type AboutIssue =
  | { kind: 'duplicate'; key: string; other: string }
  | { kind: 'long'; key: string }
  | { kind: 'language'; key: string; language: 'en' | 'de' }

/** Longer than this is hard to say on the phone (about 6 sentences). */
export const LONG_ANSWER = 450

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3),
  )

/** The share of the shorter question's words the other one has too. */
export function overlap(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / Math.min(x.size, y.size)
}

// The two languages About texts are written in today (aboutLabelsIn): common short words of each.
const GERMAN = /\b(und|der|die|das|nicht|werden|wird|kann|sind|mit|für|ist|bei|auch|oder|ich|ein|eine|wir)\b/gi
const ENGLISH = /\b(the|and|not|will|can|are|with|for|is|at|also|or|you|your|we|a|an)\b/gi

export function languageOf(s: string): 'de' | 'en' | null {
  const de = s.match(GERMAN)?.length ?? 0
  const en = s.match(ENGLISH)?.length ?? 0
  if (de + en < 3 || de === en) return null
  return de > en ? 'de' : 'en'
}

/** What may need a look: near-duplicate questions, very long answers, rows in another language than the rest. */
export function checkAbout(parts: AboutParts): AboutIssue[] {
  const issues: AboutIssue[] = []
  const qs = parts.questions.filter(q => q.question.trim() && q.answer.trim())
  const langs = qs.map(q => languageOf(`${q.question} ${q.answer}`))
  const counts = { de: 0, en: 0 }
  for (const l of [languageOf(parts.profile), ...langs]) if (l) counts[l]++
  const main = counts.de > counts.en ? 'de' : 'en'
  qs.forEach((q, i) => {
    const twin = qs.slice(0, i).find(other => overlap(q.question, other.question) >= 0.6)
    if (twin) issues.push({ kind: 'duplicate', key: q.key, other: twin.key })
    if (q.answer.length > LONG_ANSWER) issues.push({ kind: 'long', key: q.key })
    if (langs[i] && langs[i] !== main) issues.push({ kind: 'language', key: q.key, language: main })
  })
  return issues
}

/** The row Try a question's answer most likely came from: the one sharing the most words with question and answer. */
export function answeredFrom(parts: AboutParts, question: string, answer: string): AboutQuestion | null {
  const asked = words(`${question} ${answer}`)
  let best: { q: AboutQuestion; n: number } | null = null
  for (const q of parts.questions) {
    let n = 0
    for (const w of words(`${q.question} ${q.answer}`)) if (asked.has(w)) n++
    if (n >= 3 && (!best || n > best.n)) best = { q, n }
  }
  return best?.q ?? null
}
