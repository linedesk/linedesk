// The assistant must never tell a caller the call is flagged as urgent without flagging it. The model
// sometimes says "I'll flag this as urgent" and then leaves out flag_urgent (or calls it minutes later),
// so the agent also flags the call itself as soon as such a sentence has been spoken. Tool and guard go
// through one flagger, so the call is flagged (and the event line written) once.

/** A sentence in which the assistant says it flags, marks or reports the call as urgent. */
const URGENT_PROMISE =
  /\b(?:flag(?:s|ged|ging)?|mark(?:s|ed|ing)?|note[sd]?|noting)\b[^.?!]{0,40}\b(?:urgent|emergency|priority)\b|\blet (?:the team|them|someone|the (?:plumber|technician|owner)) know\b[^.?!]{0,30}\b(?:urgent|emergency)\b/i
/** Words that turn the sentence around ("I won't mark this as urgent", "is this urgent?" is not a promise anyway). */
const NEGATION = /\b(?:not|never|won't|can't|cannot|don't|isn't|wasn't)\b|n't\b/i

/** Whether the assistant's words say the call is (being) flagged as urgent. */
export function promisesUrgent(text: string): boolean {
  return text
    .split(/(?<=[.?!])\s+/)
    .some(sentence => !sentence.trim().endsWith('?') && URGENT_PROMISE.test(sentence) && !NEGATION.test(sentence))
}

/**
 * Flags the call once, however often it is asked (the tool, the guard, or both). A failed attempt
 * may be tried again.
 */
export function urgentFlagger(flag: () => Promise<void>) {
  let done: Promise<void> | null = null
  return () => {
    done ??= flag().catch(e => {
      done = null
      throw e
    })
    return done
  }
}
