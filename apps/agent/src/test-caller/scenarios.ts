// Scenarios for the call test: who the test caller plays, and what the business's call must look
// like afterwards. English only. Add one by adding an entry.
import { type Language, languageNames } from '@linedesk/actions'
import type { SimulatedOnCall } from '../call-session.ts'

export interface Expectation {
  /** The call's outcome must be one of these. */
  outcome?: string[]
  urgency?: 'urgent' | 'normal' | 'low'
  /** At least this many action items (a message taken). */
  actionItems?: number
  /** Something the assistant must say at least once (for example that it is an AI). */
  assistantSays?: RegExp
  /** The assistant's first words must match (for example the outside-hours greeting). */
  greeting?: RegExp
  /** Something the assistant must never say (for example a price or a booked time). */
  assistantAvoids?: RegExp
  /** The caller says nothing: the transcript check expects no caller turns. */
  silentCaller?: boolean
  /** The call was flagged with flag_urgent (a "Flagged as urgent" line), not only rated urgent by the summary. */
  flaggedByTool?: boolean
  /** A tool line in the call's transcript must match (for example "Callback number confirmed"). */
  toolSays?: RegExp
  /** How the warm transfer must have gone (call.transfer). */
  transferResult?: 'connected' | 'not_answered' | 'declined'
  /** The assistant asked "Are you still there?" at least this many times. */
  stillThere?: number
  /** The assistant's last line must match (for example the silence closing line). */
  lastLine?: RegExp
  /** The summary (title and text) must match (for example "Call in Spanish."). */
  summarySays?: RegExp
}

/**
 * What a booking scenario checks when the business can book (an appointment type and a calendar of a
 * connected account): the call is booked, the event exists in the calendar, and, if given, it went into
 * the calendar whose instruction matches.
 */
export interface BookingExpectation {
  calendarInstruction?: RegExp
}

export interface Scenario {
  /** Who the caller is and what they want, in the second person. Empty: the caller stays silent. */
  persona: string
  /** Checked when the business cannot book; for every scenario without `booking`, always. */
  expect: Expectation
  /** Checked instead of `expect` when the business can book. */
  booking?: BookingExpectation
  /** Business hours the business's agent uses in a no-phone test, instead of the workspace's. */
  businessHours?: { openNow: boolean; summary: string }
  /** An outside-hours greeting the business's agent uses in a no-phone test, instead of the assistant's. */
  outsideGreeting?: string
  /**
   * No-phone test only: transfer of urgent calls is on, to this number, and a simulated on-call person
   * answers instead of a phone (nothing is dialled). With --phone the assistant's real settings apply.
   */
  onCall?: SimulatedOnCall
  /** A silent caller (empty persona) stays on the line this long; default SILENT_CALLER_MS. */
  silentForMs?: number
  /**
   * The caller goes silent after this many of its own lines: it stops listening and speaking (a model cannot say
   * nothing; "..." comes out as made-up words) and stays on the line for `silentForMs`.
   */
  silentAfterLines?: number
  /**
   * No-phone test only: languages besides English the business's assistant speaks on this call, instead of
   * its own setting. The test caller then understands them too.
   */
  languages?: Language[]
}

const rules = (language: string) =>
  `You are on a real phone call with a business's phone assistant. Wait until you are greeted, then answer like a person would on the phone: one or two short sentences per turn, plain spoken ${language}, no lists. Give your details only when asked. When you have what you called for, or after about six of your own turns, say a short goodbye and then use the end_call tool. Never say that you are an AI or that this is a test.`

const MESSAGE_OUTCOMES = ['message', 'callback']

export const scenarios = {
  'callback-message': {
    persona:
      'You are Lena Brooks. You got a quote from the owner last week for a new kitchen faucet and want him to call you back to go ahead with it. Your number is the one you are calling from; afternoons are best.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1 },
  },
  'burst-pipe': {
    persona:
      'You are Dana Ruiz. A pipe under your kitchen sink just burst and water is spraying everywhere; you have shut off the main valve. You want a plumber out as soon as possible. Your address is 1450 Southeast Division Street, Portland, and this number is the best way to reach you.',
    // Whether this is urgent is the business's call (its own text), not a fixed rule: only the message is checked.
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1 },
  },
  // The assistant tends to say "I'll flag this as urgent" first: the flag must follow the words.
  'urgent-promise': {
    persona:
      'You are Tom Becker. A pipe burst in your basement and water is everywhere; you have not found the main valve yet. Say right away that it is an emergency and ask them to make sure the team knows it is urgent. Your address is 42 Oak Street, Portland, and this number is the best way to reach you.',
    expect: { outcome: MESSAGE_OUTCOMES, urgency: 'urgent', actionItems: 1, flaggedByTool: true },
  },
  'price-question': {
    persona:
      'You are Chris Moore. You want to know how much it costs to unclog a bathroom drain and whether there is a call-out fee. Push once for a ballpark number. If they cannot say, leave your name and ask for a call back.',
    expect: { outcome: MESSAGE_OUTCOMES, assistantAvoids: /\$\s?\d+(?:[.,]\d+)*|\b\d+\s?dollars\b/i },
  },
  // With a connected calendar the assistant books; without one it must take a message and never claim a booking.
  booking: {
    persona:
      'You are Sam Patel. You want a maintenance visit for your water heater, ideally a morning next week, and expect it to be booked on this call. Accept the first time offered that works for a weekday; if none is offered, ask them to call you back. Your address is 220 Northeast Alberta Street, Portland.',
    expect: {
      outcome: MESSAGE_OUTCOMES,
      actionItems: 1,
      assistantAvoids: /\b(you're|you are) (all )?(booked|scheduled|confirmed)\b|\bI('ve| have) (booked|scheduled)\b/i,
    },
    booking: {},
  },
  // The calendar notes decide: an emergency goes into the calendar whose note says so ("Emergencies").
  'which-calendar': {
    persona:
      'You are Dana Ruiz. Water is leaking from the ceiling under your upstairs bathroom; you have turned off the water. You want someone out as soon as possible and accept the earliest time offered. Your address is 1450 Southeast Division Street, Portland.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1 },
    booking: { calendarInstruction: /emergenc|urgent/i },
  },
  'wrong-number': {
    persona:
      "You meant to call Lucky's Pizza to order a large pepperoni. When you notice it is a plumbing company, apologize briefly and end the call.",
    expect: { outcome: ['hangup', 'answered', 'spam', 'message'] },
  },
  'robot-question': {
    persona:
      'You are Pat Lee with a dripping bathroom faucet. Early in the call, ask straight out: "Wait, am I talking to a real person or a robot?" Then go on and leave a message about the faucet.',
    expect: {
      outcome: MESSAGE_OUTCOMES,
      assistantSays: /\b(AI|artificial intelligence|virtual assistant|automated assistant)\b/i,
    },
  },
  interrupter: {
    persona:
      'You are Morgan Hale, in a hurry and talkative. You need someone to look at your noisy furnace. Answer in long run-on sentences, change your mind once about the best day, and cut in with new details instead of answering the question you were asked.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1 },
  },
  // Without a phone the business is closed by the scenario; over the phone the workspace's real hours apply.
  'after-hours': {
    persona:
      'You are Jordan Kim. Your toilet keeps running; it is not an emergency. Ask whether they are open right now and when someone will call you back, then leave your name and ask for a call back.',
    expect: {
      outcome: MESSAGE_OUTCOMES,
      actionItems: 1,
      urgency: 'normal',
      assistantSays: /\b(closed|opens?|open (again|tomorrow|on|at)|business hours|office hours)\b/i,
      greeting: /after-hours line/i,
    },
    businessHours: {
      openNow: false,
      summary: 'Business hours: Monday–Friday 7 AM–6 PM (America/Los_Angeles). Closed now; opens tomorrow at 7 AM.',
    },
    outsideGreeting:
      "Thanks for calling. You've reached our after-hours line; the office is closed right now. How can I help?",
  },
  // Warm transfer (no phone: a simulated on-call person in the consult room, nothing is dialled).
  'transfer-accepted': {
    persona:
      'You are Dana Ruiz. A pipe under your kitchen sink just burst and water is spraying everywhere; you have shut off the main valve. You need a plumber right now. Your address is 1450 Southeast Division Street, Portland, Oregon 97202. Give your name when asked. If they put you through to someone, stay on the line quietly while it rings, then talk to the person; when they say goodbye, say goodbye too.',
    expect: { outcome: ['transferred'], transferResult: 'connected' },
    onCall: { answer: 'accept', number: '+15035550199' },
  },
  'transfer-no-answer': {
    persona:
      'You are Dana Ruiz. A pipe under your kitchen sink just burst and water is spraying everywhere; you have shut off the main valve. You need a plumber right now. Your address is 1450 Southeast Division Street, Portland, Oregon 97202. Give your name when asked. If they put you through to someone, stay on the line quietly while it rings. If nobody answers, leave a message that this number is the best way to reach you.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1, transferResult: 'not_answered' },
    onCall: { answer: 'no-answer', number: '+15035550199' },
  },
  'transfer-declined': {
    persona:
      'You are Dana Ruiz. Water is leaking through your ceiling from the upstairs bathroom; you have turned off the water. You need someone today. Your address is 1450 Southeast Division Street, Portland, Oregon 97202. Give your name when asked. If they put you through to someone, stay on the line quietly while it rings. If nobody can take it, leave a message that this number is the best way to reach you.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1, transferResult: 'declined' },
    onCall: { answer: 'decline', number: '+15035550199' },
  },
  silence: {
    persona: '',
    expect: { outcome: ['hangup'], silentCaller: true },
  },
  // Silence until the end: reminders, then the closing line, and the assistant hangs up (defaults: asks at 8 s and 24 s, closes at 56 s).
  'silence-closing': {
    persona: '',
    silentForMs: 100_000,
    expect: { outcome: ['hangup'], silentCaller: true, stillThere: 2, lastLine: /can't hear anyone on the line/i },
  },
  // Silence in the middle of the call: the caller says what they want, then nothing more, so the assistant's question
  // goes unanswered. Reminders, the closing line, and the assistant hangs up.
  'silence-mid-call': {
    persona:
      'You are Pat Lee. Your bathroom faucet is dripping and you want someone to come and look at it. Say that in one short sentence.',
    silentAfterLines: 1,
    silentForMs: 100_000,
    expect: { stillThere: 2, lastLine: /can't hear anyone on the line/i },
  },
  // Two urgent contacts with the same condition, the first set to "try the next": nobody answers, both are tried in order.
  'transfer-next': {
    persona:
      'You are Dana Ruiz. A pipe under your kitchen sink just burst and water is spraying everywhere; you have shut off the main valve. You need a plumber right now. Your address is 1450 Southeast Division Street, Portland, Oregon 97202. Give your name when asked. If they put you through to someone, stay on the line quietly while it rings, also when they try someone else. If nobody answers, say this number is the best way to reach you and say goodbye.',
    expect: {
      outcome: MESSAGE_OUTCOMES,
      actionItems: 1,
      transferResult: 'not_answered',
      assistantSays: /let me try sarah/i,
    },
    onCall: { answer: 'no-answer', number: '+15035550199', backup: true },
  },
  // Transfer rule "The caller asks to speak to a person" (not an emergency): put through, and the call stays not urgent.
  'transfer-person': {
    persona:
      'You are Alex Romero. You have a question about an invoice from last month and want to talk to the owner himself, not leave a message. Ask to speak to a real person. Give your name when asked. If they put you through to someone, stay on the line quietly while it rings, then talk to the person; when they say goodbye, say goodbye too.',
    expect: { outcome: ['transferred'], urgency: 'normal', transferResult: 'connected' },
    onCall: { answer: 'accept', number: '+15035550199', for: 'person' },
  },
  // Languages: Spanish allowed, the caller speaks only Spanish. The assistant answers in Spanish, the summary stays English.
  'spanish-caller': {
    persona:
      'Eres María González. Hablas solo español, nada de inglés. El inodoro de tu baño gotea y quieres que un fontanero te llame para arreglarlo esta semana. Da tu nombre cuando te lo pidan. Despídete con "adiós" y cuelga.',
    expect: {
      outcome: MESSAGE_OUTCOMES,
      actionItems: 1,
      assistantSays: /\b(gracias|nombre|ayudar|llam\w*|fontaner\w*|inodoro)\b/i,
      summarySays: /\bSpanish\b/,
    },
    languages: ['es'],
  },
} satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof scenarios
export const scenarioNames = Object.keys(scenarios) as ScenarioName[]
export const isScenario = (name: string): name is ScenarioName => Object.hasOwn(scenarios, name)

/** The caller's instructions; `today` (for example "Wednesday, November 11, 2026") so dates the caller says are in the right year. */
export const callerInstructions = (scenario: Scenario, today = todayInWords()) =>
  `${rules(scenario.languages?.length ? languageNames(scenario.languages, 'or') : 'English')} Today is ${today}.\n\n${scenario.persona}`

const todayInWords = (now = new Date()) =>
  now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  })

/** How the call test reaches the business: through the phone network, or inside one LiveKit room. */
export type CallTestMode = 'phone' | 'room'

/** What the test caller reads from the job metadata of its room (set by the call-test command). */
export type TestCallerMetadata = {
  source: 'test-caller'
  scenario: ScenarioName
  mode: CallTestMode
  /** Who the caller is instead of the scenario's persona (call-test --persona); the scenario's checks stay. */
  persona?: string
}

export function parseTestCallerMetadata(metadata: string): TestCallerMetadata | null {
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; scenario?: unknown; mode?: unknown; persona?: unknown }
    if (parsed.source !== 'test-caller' || typeof parsed.scenario !== 'string' || !isScenario(parsed.scenario))
      return null
    const persona = typeof parsed.persona === 'string' && parsed.persona.trim() ? parsed.persona.trim() : undefined
    return {
      source: 'test-caller',
      scenario: parsed.scenario,
      mode: parsed.mode === 'room' ? 'room' : 'phone',
      ...(persona ? { persona } : {}),
    }
  } catch {
    return null
  }
}

/** The call-test command line: the scenario name (the first word that is no flag and not the --persona text) and the persona. */
export function parseCallTestArgs(args: readonly string[]): {
  name: string
  persona: string | undefined
  pipeline: string | undefined
  realtimeModel: string | undefined
} {
  // The word after --persona, --pipeline and --realtime-model is their value, never the scenario.
  const valueAt = (flag: string) => (args.includes(flag) ? args.indexOf(flag) + 1 : -1)
  const values = [valueAt('--persona'), valueAt('--pipeline'), valueAt('--realtime-model')]
  const name = args.find((a, i) => !a.startsWith('--') && !values.includes(i)) ?? ''
  const [persona, pipeline, realtimeModel] = values.map(i => (i >= 0 ? args[i] : undefined))
  return { name, persona, pipeline, realtimeModel }
}

/**
 * Transfer scenarios run without a phone only: over the phone they would page a real on-call phone.
 * Exception: the live warm-transfer test (CALL_TEST_ONCALL set), where the agent puts a phone call test
 * through only to that number, the on-call responder. Never with --external: the other install answers and
 * does any transfer itself, so its real on-call phone would ring whatever CALL_TEST_ONCALL says.
 */
export const phoneRefused = (
  scenario: Scenario,
  env: Record<string, string | undefined> = process.env,
  external = false,
) => scenario.onCall !== undefined && (external || !env.CALL_TEST_ONCALL)
