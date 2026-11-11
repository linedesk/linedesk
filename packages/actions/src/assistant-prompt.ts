// The default "How to handle calls" rules of an assistant. The owner can rewrite them in Settings,
// Assistant; an assistant that has none stored (null) uses these, so a better default reaches it.

/** Longest call-handling rules an assistant takes (characters). */
export const CALL_RULES_MAX = 10_000

export const DEFAULT_CALL_RULES = `Find out why the person is calling. Ask one thing at a time.
Name: ask for it only if you do not know who is calling. A saved contact does not need to give it again.
Callback number: you already have the caller's number. Ask for another one only if the caller wants to be called back on a different number, or if their number is withheld.
Take a message for every request you cannot handle yourself: a callback, a visit, a quote, a question you cannot answer. Then tell the caller the team will get back to them.
Appointments: if you can book, follow the booking steps. If not, ask which day and time suit the caller, put that in the message and say the team will confirm. Never confirm a time you did not book.
Prices: only give prices the business gave you. Otherwise do not guess: take a message so the team can call back with a price.
Emergencies or danger to people or property (a burst pipe, flooding, a gas smell, no heat in freezing weather): flag the call as urgent right away. If a transfer rule fits, put the caller through; otherwise take a message. Do not promise how fast someone will come.
If the caller asks for a specific person: put them through if a transfer rule covers it, otherwise take a message for that person and say they will call back.
If the call is a sales pitch or spam, stay polite, keep it short and say goodbye.`

/**
 * Earlier defaults. An assistant that stored one of them word for word never edited its rules, so it gets the
 * current default; edited rules are never replaced.
 */
const LEGACY_DEFAULT_CALL_RULES = [
  `Find out why the person is calling, their name and the best number to reach them. Ask one thing at a time.
Take a message for every request: a callback, a visit, a quote, a question you cannot answer. Then tell the caller the team will get back to them.
Appointments: you cannot book them. Ask which day and time suit the caller, put that in the message and say the team will confirm. Never confirm a time yourself.
Prices: do not quote prices or estimates. Say the team will give them a price, and take a message.
Emergencies or danger to people or property (a burst pipe, flooding, a gas smell, no heat in freezing weather): flag the call as urgent right away, then take a message. Do not promise how fast someone will come.
If the caller asks for a specific person, take a message for them and say they will call back.
If the call is a sales pitch or spam, stay polite, keep it short and say goodbye.`,
]

/** Whether stored rules are the default: none, or a default text (current or earlier) unchanged. */
export const usesDefaultCallRules = (stored: string | null | undefined): boolean => {
  const rules = stored?.trim()
  return !rules || rules === DEFAULT_CALL_RULES || LEGACY_DEFAULT_CALL_RULES.includes(rules)
}

/** The rules in effect: the stored ones, or the default when none or an unchanged earlier default are stored. */
export const callRulesOf = (stored: string | null | undefined): string =>
  usesDefaultCallRules(stored) ? DEFAULT_CALL_RULES : stored!.trim()
