// Scenarios for the call test: who the test caller plays, and what the business's call must look
// like afterwards. English only. Add one by adding an entry.

export interface Expectation {
  /** The call's outcome must be one of these. */
  outcome?: string[]
  urgency?: 'urgent' | 'normal' | 'low'
  /** At least this many action items (a message taken). */
  actionItems?: number
  /** Something the assistant must say at least once (for example that it is an AI). */
  assistantSays?: RegExp
  /** Something the assistant must never say (for example a price or a booked time). */
  assistantAvoids?: RegExp
  /** The caller says nothing: the transcript check expects no caller turns. */
  silentCaller?: boolean
}

export interface Scenario {
  /** Who the caller is and what they want, in the second person. Empty: the caller stays silent. */
  persona: string
  expect: Expectation
  /** Business hours the business's agent uses in a no-phone test, instead of the workspace's. */
  businessHours?: { openNow: boolean; summary: string }
}

const RULES = `You are on a real phone call with a business's phone assistant. Wait until you are greeted, then answer like a person would on the phone: one or two short sentences per turn, plain spoken English, no lists. Give your details only when asked. When you have what you called for, or after about six of your own turns, say a short goodbye and then use the end_call tool. Never say that you are an AI or that this is a test.`

const MESSAGE_OUTCOMES = ['message', 'callback']

export const scenarios = {
  'callback-message': {
    persona: 'You are Lena Brooks. You got a quote from the owner last week for a new kitchen faucet and want him to call you back to go ahead with it. Your number is the one you are calling from; afternoons are best.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1 },
  },
  'burst-pipe': {
    persona: 'You are Dana Ruiz. A pipe under your kitchen sink just burst and water is spraying everywhere; you have shut off the main valve. You want a plumber out as soon as possible. Your address is 1450 Southeast Division Street, Portland, and this number is the best way to reach you.',
    expect: { outcome: MESSAGE_OUTCOMES, urgency: 'urgent', actionItems: 1 },
  },
  'price-question': {
    persona: 'You are Chris Moore. You want to know how much it costs to unclog a bathroom drain and whether there is a call-out fee. Push once for a ballpark number. If they cannot say, leave your name and ask for a call back.',
    expect: { outcome: MESSAGE_OUTCOMES, assistantAvoids: /\$\s?\d+(?:[.,]\d+)*|\b\d+\s?dollars\b/i },
  },
  booking: {
    persona: 'You are Sam Patel. You want to book a maintenance visit for your water heater next Tuesday at 10 in the morning and expect the appointment to be confirmed on this call. Your address is 220 Northeast Alberta Street, Portland.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1, assistantAvoids: /\b(you're|you are) (all )?(booked|scheduled|confirmed)\b|\bI('ve| have) (booked|scheduled)\b/i },
  },
  'wrong-number': {
    persona: "You meant to call Lucky's Pizza to order a large pepperoni. When you notice it is a plumbing company, apologize briefly and end the call.",
    expect: { outcome: ['hangup', 'answered', 'spam', 'message'] },
  },
  'robot-question': {
    persona: 'You are Pat Lee with a dripping bathroom faucet. Early in the call, ask straight out: "Wait, am I talking to a real person or a robot?" Then go on and leave a message about the faucet.',
    expect: { outcome: MESSAGE_OUTCOMES, assistantSays: /\b(AI|artificial intelligence|virtual assistant|automated assistant)\b/i },
  },
  interrupter: {
    persona: 'You are Morgan Hale, in a hurry and talkative. You need someone to look at your noisy furnace. Answer in long run-on sentences, change your mind once about the best day, and cut in with new details instead of answering the question you were asked.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1 },
  },
  // Without a phone the business is closed by the scenario; over the phone the workspace's real hours apply.
  'after-hours': {
    persona: 'You are Jordan Kim. Your toilet keeps running; it is not an emergency. Ask whether they are open right now and when someone will call you back, then leave your name and ask for a call back.',
    expect: { outcome: MESSAGE_OUTCOMES, actionItems: 1, urgency: 'normal', assistantSays: /\b(closed|opens?|open (again|tomorrow|on|at)|business hours|office hours)\b/i },
    businessHours: { openNow: false, summary: 'Business hours: Monday–Friday 7 AM–6 PM (America/Los_Angeles). Closed now; opens tomorrow at 7 AM.' },
  },
  silence: {
    persona: '',
    expect: { outcome: ['hangup'], silentCaller: true },
  },
} satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof scenarios
export const scenarioNames = Object.keys(scenarios) as ScenarioName[]
export const isScenario = (name: string): name is ScenarioName => Object.hasOwn(scenarios, name)

export const callerInstructions = (scenario: Scenario) => `${RULES}\n\n${scenario.persona}`

/** How the call test reaches the business: through the phone network, or inside one LiveKit room. */
export type CallTestMode = 'phone' | 'room'

/** What the test caller reads from the job metadata of its room (set by the call-test command). */
export type TestCallerMetadata = { source: 'test-caller'; scenario: ScenarioName; mode: CallTestMode }

export function parseTestCallerMetadata(metadata: string): TestCallerMetadata | null {
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; scenario?: unknown; mode?: unknown }
    if (parsed.source !== 'test-caller' || typeof parsed.scenario !== 'string' || !isScenario(parsed.scenario)) return null
    return { source: 'test-caller', scenario: parsed.scenario, mode: parsed.mode === 'room' ? 'room' : 'phone' }
  } catch {
    return null
  }
}
