// Scenarios for the phone-to-phone call test: who the test caller pretends to be, and what the
// business's call must look like afterwards. Add one by adding an entry.

export interface Expectation {
  /** The call's outcome must be one of these. */
  outcome?: string[]
  urgency?: 'urgent' | 'normal' | 'low'
}

export interface Scenario {
  /** Who the caller is and what they want, in the second person. */
  persona: string
  expect: Expectation
}

const RULES = `You are on a real phone call with a business's phone assistant. Wait until you are greeted, then answer like a person would on the phone: one or two short sentences per turn, plain spoken English, no lists. Give your details only when asked. When you have what you called for, or after about six of your own turns, say a short goodbye and then use the end_call tool. Never say that you are an AI or that this is a test.`

export const scenarios = {
  'burst-pipe': {
    persona: 'You are Dana Ruiz. A pipe under your kitchen sink just burst and water is spraying everywhere; you have shut off the main valve. You want a plumber out as soon as possible. Your address is 1450 Southeast Division Street, Portland, and this number is the best way to reach you.',
    expect: { outcome: ['callback', 'message'], urgency: 'urgent' },
  },
  booking: {
    persona: 'You are Sam Patel. Your gas water heater is eight years old and you would like a maintenance visit next week, ideally Tuesday or Wednesday morning. Nothing is broken. Your address is 220 Northeast Alberta Street, Portland.',
    expect: { outcome: ['callback', 'message', 'booked'] },
  },
  'wrong-number': {
    persona: "You meant to call Lucky's Pizza to order a large pepperoni. When you notice it is a plumbing company, apologize briefly and end the call.",
    expect: { outcome: ['hangup', 'answered', 'spam', 'message'] },
  },
} satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof scenarios
export const scenarioNames = Object.keys(scenarios) as ScenarioName[]
export const isScenario = (name: string): name is ScenarioName => Object.hasOwn(scenarios, name)

export const callerInstructions = (scenario: Scenario) => `${RULES}\n\n${scenario.persona}`

/** What the test caller reads from the job metadata of its room (set by the call-test command). */
export type TestCallerMetadata = { source: 'test-caller'; scenario: ScenarioName }

export function parseTestCallerMetadata(metadata: string): TestCallerMetadata | null {
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; scenario?: unknown }
    return parsed.source === 'test-caller' && typeof parsed.scenario === 'string' && isScenario(parsed.scenario)
      ? { source: 'test-caller', scenario: parsed.scenario }
      : null
  } catch {
    return null
  }
}
