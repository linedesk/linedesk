// After-call transcription (after-call-transcript.ts): a stronger model hears the whole recording again. This puts
// what it heard back onto the call's lines. Some services give plain text only (OpenAI); others give turns with
// speaker labels and times (Deepgram, AssemblyAI, ElevenLabs): then the turns are taken in their order, the speaker
// whose words fit the assistant's lines is the assistant, and the one who said most of the rest is the caller. The assistant's lines are
// exact already (the text its voice spoke), so they are the anchors: the words of the new text are aligned with the
// words of the call's lines (longest common subsequence), and the words between the anchors go to the caller's lines
// there. Only the caller's lines change; the assistant's, the team's and the tool lines stay as they are. A caller who
// cuts the assistant off leaves its line unfinished ("I can take a"), while the recording still has the rest ("message
// for"): words heard right after such a line are the assistant's, never the caller's (cutOff). Pure.

/** A line of the call's transcript as stored (transcript_segments), in order. */
export type StoredLine = { id: string; speaker: 'agent' | 'caller' | 'human' | 'system'; text: string }
/** A caller's line with the words the new transcription heard for it. */
export type CallerLineUpdate = { id: string; text: string }

/** Above this, the alignment would take too much memory and time: the transcript is left as it is. */
export const MAX_ALIGN_CELLS = 8_000_000
/** Below this share of the assistant's words found in the new text, it is not trusted (another call, garbled audio). */
export const MIN_ANCHOR_SHARE = 0.5

const DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
}

/**
 * The forms a word is compared in: lower case without punctuation, digits one by one and number words as digits, so
 * "555-123" (the new text) meets "five five five one two three" (what live speech recognition wrote).
 */
export function normalizeWord(word: string): string[] {
  const plain = word
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  if (!plain) return []
  return plain.split(/\s+/).flatMap(part => {
    if (DIGIT_WORDS[part]) return [DIGIT_WORDS[part]]
    if (/^\d+$/.test(part)) return part.split('')
    return [part]
  })
}

type RefToken = { norm: string; line: number }
/** Who said a word, as speaker labels tell; null: not known (plain text, or a third voice). */
type Role = 'agent' | 'caller' | null
type HypToken = { norm: string; word: number; role: Role }
/** A turn as a service with speaker labels hears it (transcriber.ts, HeardTurn). */
export type Turn = { speaker: string; start: number; text: string }

/** Below this share of a speaker's words found in the assistant's lines, no speaker is taken to be the assistant. */
export const MIN_AGENT_SPEAKER_SHARE = 0.6

/** The words of the new text, each with who said it where the turns tell. */
function heardWords(lines: StoredLine[], heard: string | { text: string; turns?: Turn[] }) {
  const turns = typeof heard === 'string' ? [] : [...(heard.turns ?? [])].sort((a, b) => a.start - b.start)
  if (turns.length < 2) {
    const text = typeof heard === 'string' ? heard : heard.text
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map(word => ({ word, role: null as Role }))
  }
  const roles = rolesOf(lines, turns)
  return turns.flatMap(turn =>
    turn.text
      .split(/\s+/)
      .filter(Boolean)
      .map(word => ({ word, role: roles.get(turn.speaker) ?? null })),
  )
}

/** The assistant: the speaker whose words are mostly the assistant's; the caller: who said most of the others'. */
function rolesOf(lines: StoredLine[], turns: Turn[]): Map<string, Role> {
  const agentWords = new Set(
    lines.filter(l => l.speaker === 'agent').flatMap(l => l.text.split(/\s+/).flatMap(normalizeWord)),
  )
  const said = new Map<string, string[]>()
  for (const turn of turns)
    said.set(turn.speaker, [...(said.get(turn.speaker) ?? []), ...turn.text.split(/\s+/).flatMap(normalizeWord)])
  if (said.size < 2) return new Map()
  const share = (words: string[]) => (words.length ? words.filter(w => agentWords.has(w)).length / words.length : 0)
  const ranked = [...said.entries()].sort((a, b) => share(b[1]) - share(a[1]))
  const [agent, agentSaid] = ranked[0]!
  if (share(agentSaid) < MIN_AGENT_SPEAKER_SHARE || share(agentSaid) === share(ranked[1]![1])) return new Map()
  const caller = ranked.slice(1).sort((a, b) => b[1].length - a[1].length)[0]![0]
  return new Map<string, Role>([
    [agent, 'agent'],
    [caller, 'caller'],
  ])
}

/** Whether a heard word may stand for a word of this line: the assistant's words only for its lines, the caller's for theirs. */
const fits = (role: Role, speaker: StoredLine['speaker']) =>
  role === null || (role === 'agent' ? speaker !== 'caller' : speaker === 'caller')

/** An assistant line the caller cut off: it does not end like a sentence ("I can take a"). */
const unfinished = (line: StoredLine) => line.speaker === 'agent' && !/[.!?…:;"”')\]]\s*$/.test(line.text)

function tokensOf(lines: StoredLine[]): RefToken[] {
  return lines.flatMap((line, index) =>
    line.speaker === 'system'
      ? []
      : line.text.split(/\s+/).flatMap(word => normalizeWord(word).map(norm => ({ norm, line: index }))),
  )
}

/** Pairs of matching positions [ref, hyp], in order: the longest common subsequence of the two word lists. */
function commonSubsequence(lines: StoredLine[], ref: RefToken[], hyp: HypToken[]): [number, number][] {
  const same = (i: number, j: number) =>
    ref[i]!.norm === hyp[j]!.norm && fits(hyp[j]!.role, lines[ref[i]!.line]!.speaker)
  const n = ref.length
  const m = hyp.length
  const width = m + 1
  // Lengths of the common subsequence of the suffixes ref[i..] and hyp[j..].
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] = same(i, j)
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(i, j)) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++
    else j++
  }
  return pairs
}

/**
 * The caller's lines with the words the new transcription heard for them; a line it heard nothing for keeps its text
 * (not listed). Empty when the new text cannot be trusted: too few of the assistant's words found in it, or too long.
 * `heard`: plain text, or the text with the turns a service with speaker labels heard.
 */
export function alignCallerLines(
  lines: StoredLine[],
  heard: string | { text: string; turns?: Turn[] },
): CallerLineUpdate[] {
  const said = heardWords(lines, heard)
  const words = said.map(w => w.word)
  const hyp: HypToken[] = said.flatMap(({ word, role }, index) =>
    normalizeWord(word).map(norm => ({ norm, word: index, role })),
  )
  const ref = tokensOf(lines)
  const agentTokens = ref.filter(t => lines[t.line]!.speaker === 'agent').length
  if (!hyp.length || !agentTokens || !lines.some(l => l.speaker === 'caller')) return []
  if ((ref.length + 1) * (hyp.length + 1) > MAX_ALIGN_CELLS) return []

  const pairs = commonSubsequence(lines, ref, hyp)
  const anchored = pairs.filter(([r]) => lines[ref[r]!.line]!.speaker === 'agent').length
  if (anchored / agentTokens < MIN_ANCHOR_SHARE) return []

  // The line each word of the new text belongs to; -1: none (the assistant's or nobody's).
  const lineOfHyp = new Array<number>(hyp.length).fill(-1)
  for (const [r, h] of pairs) lineOfHyp[h] = ref[r]!.line
  const matchedRef = new Set(pairs.map(([r]) => r))

  // Each run of unmatched words between two matches goes to the lines there, in order: split by how many of each
  // line's words are unmatched in that stretch (the words the new text heard differently).
  const bounds: [number, number][] = [[-1, -1], ...pairs, [ref.length, hyp.length]]
  // Caller lines after a cut-off assistant line whose words could not be told apart: they keep their text.
  const keptAsStored = new Set<number>()
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [r0, h0] = bounds[k]!
    const [r1, h1] = bounds[k + 1]!
    const run = hyp.slice(h0 + 1, h1).map((_, i) => h0 + 1 + i)
    if (!run.length) continue
    // Right after the last word of a cut-off assistant line: the rest of what the assistant said, then perhaps the
    // caller. Which words are whose is not known, so the caller's line there is not changed (keptAsStored), and
    // words heard where the caller's line has none are the assistant's.
    const cutOff = r0 >= 0 && (r0 + 1 >= ref.length || ref[r0 + 1]!.line !== ref[r0]!.line) && unfinished(lines[ref[r0]!.line]!)
    const weights = new Map<number, number>()
    for (let r = r0 + 1; r < r1; r++)
      if (!matchedRef.has(r)) weights.set(ref[r]!.line, (weights.get(ref[r]!.line) ?? 0) + 1)
    if (weights.size && cutOff) {
      for (const line of weights.keys()) keptAsStored.add(line)
      continue
    }
    if (weights.size) {
      const total = [...weights.values()].reduce((a, b) => a + b, 0)
      const slots = [...weights.entries()]
      let at = 0
      let filled = 0
      run.forEach((h, i) => {
        while (at < slots.length - 1 && (i + 0.5) / run.length > (filled + slots[at]![1]) / total)
          filled += slots[at++]![1]
        lineOfHyp[h] = slots[at]![0]
      })
      continue
    }
    // Words heard where the lines have none (nothing unmatched between): the caller's line on either side.
    const before = r0 >= 0 ? ref[r0]!.line : -1
    const after = r1 < ref.length ? ref[r1]!.line : -1
    const target = cutOff ? -1 : ([before, after].find(line => line >= 0 && lines[line]!.speaker === 'caller') ?? -1)
    for (const h of run) lineOfHyp[h] = target
  }

  // With speaker labels: the assistant's words never go to a caller line, and the caller's go to the nearest caller
  // line of their stretch when the split above put them elsewhere.
  if (hyp.some(t => t.role)) {
    let lastCaller = -1
    const nextCaller = (from: number) => lines.findIndex((l, i) => i >= from && l.speaker === 'caller')
    hyp.forEach((token, h) => {
      const line = lineOfHyp[h]!
      if (line >= 0 && lines[line]!.speaker === 'caller') lastCaller = line
      if (token.role === 'agent' && line >= 0 && lines[line]!.speaker === 'caller') lineOfHyp[h] = -1
      if (token.role === 'caller' && (line < 0 || lines[line]!.speaker !== 'caller')) {
        const after = line >= 0 ? nextCaller(line) : -1
        lineOfHyp[h] = lastCaller >= 0 ? lastCaller : after
      }
    })
  }

  const byLine = new Map<number, number[]>()
  hyp.forEach((token, h) => {
    const line = lineOfHyp[h]!
    if (line < 0 || lines[line]!.speaker !== 'caller' || keptAsStored.has(line)) return
    const list = byLine.get(line) ?? []
    if (list.at(-1) !== token.word) list.push(token.word)
    byLine.set(line, list)
  })
  return [...byLine.entries()].flatMap(([line, wordIndexes]) => {
    const text = wordIndexes
      .map(w => words[w])
      .join(' ')
      .trim()
    const stored = lines[line]!
    return text && text !== stored.text ? [{ id: stored.id, text }] : []
  })
}
