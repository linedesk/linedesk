// Scripted calls for the simulator. `{greeting}` is replaced by the assistant's configured greeting.
import type { CallResult, Speaker } from './call-session.ts'

export interface SimLine {
  speaker: Speaker
  text: string
  /** Set on system lines: the tool the assistant used. */
  tool?: string
}

export interface SimScript {
  from: string
  lines: SimLine[]
  result: CallResult
}

const agent = (text: string): SimLine => ({ speaker: 'agent', text })
const caller = (text: string): SimLine => ({ speaker: 'caller', text })
const tool = (name: string, text: string): SimLine => ({ speaker: 'system', text, tool: name })

export const simScripts = {
  leak: {
    from: '+15035550191',
    lines: [
      agent('{greeting}'),
      caller('Hi, yes, I have water coming through my ceiling. I think a pipe upstairs broke.'),
      agent('I am sorry, that sounds stressful. Is the water still running right now?'),
      caller('Yes, it is dripping through the light fixture in the hallway.'),
      agent('Please stay away from that light and switch off the breaker for the hallway if you can do it safely. Do you know where your main water shut-off is?'),
      caller('In the garage I think. My husband is going there now.'),
      tool('call.flagUrgent', 'Flagged as urgent'),
      agent('Good. I have marked this as an emergency. Can I get your name and the address?'),
      caller('Elena Novak, 2218 Southeast Hawthorne Boulevard.'),
      tool('call.takeMessage', 'Took a message'),
      agent('Thank you, Elena. Mike will call you back on this number within fifteen minutes. Keep the water off until he gets there.'),
      caller('Okay. Please hurry. Thank you.'),
    ],
    result: {
      outcome: 'callback', urgency: 'urgent', callerName: 'Elena Novak',
      title: 'Water leaking through hallway ceiling',
      summary: 'A pipe upstairs seems to have burst; water is dripping through the hallway light fixture. She is shutting off the main valve and wants someone out right away.',
      actionItems: [{ text: 'Call Elena back within 15 minutes' }, { text: 'Send someone to 2218 SE Hawthorne Blvd today' }],
      fields: [{ label: 'Address', value: '2218 SE Hawthorne Blvd, Portland' }, { label: 'Problem', value: 'Ceiling leak, upstairs pipe' }],
    },
  },
  booking: {
    from: '+15035550158',
    lines: [
      agent('{greeting}'),
      caller('Hi, I would like someone to look at my furnace before winter.'),
      agent('Happy to help with that. Is the furnace running at the moment, or is it not working?'),
      caller('It runs, but it makes a rattling noise when it starts up.'),
      agent('Got it. Is it a gas furnace, and do you know roughly how old it is?'),
      caller('Gas, about twelve years old.'),
      agent('Thanks. Which days work best for a visit?'),
      caller('Any morning next week, Tuesday or Wednesday would be ideal.'),
      agent('And who am I speaking with?'),
      caller('James Carter. I am in Beaverton, 740 Southwest Cedar Hills Boulevard.'),
      tool('call.takeMessage', 'Took a message'),
      agent('Thank you, James. I have noted a furnace check for Tuesday or Wednesday morning next week. Someone from the team will call you to confirm the exact time.'),
      caller('Great, thanks a lot.'),
    ],
    result: {
      outcome: 'callback', urgency: 'normal', callerName: 'James Carter',
      title: 'Furnace check before winter',
      summary: 'Twelve-year-old gas furnace rattles on start-up but still runs. He wants a visit next week, Tuesday or Wednesday morning, in Beaverton.',
      actionItems: [{ text: 'Confirm a visit for Tue or Wed morning next week' }],
      fields: [{ label: 'Address', value: '740 SW Cedar Hills Blvd, Beaverton' }, { label: 'Preferred time', value: 'Tue or Wed morning next week' }],
    },
  },
  message: {
    from: '+15035550176',
    lines: [
      agent('{greeting}'),
      caller('Hi, this is Olivia from Cascade Supply. Is Mike around?'),
      agent('Mike is out on a job right now. I can take a message and make sure he gets it.'),
      caller('Sure. The tankless heater he ordered came in, he can pick it up any time before five.'),
      agent('Thanks, Olivia. Is there an order number he should mention?'),
      caller('Order 48213. And we close at noon on Saturday.'),
      tool('call.takeMessage', 'Took a message'),
      agent('I have noted that the heater from order 48213 is ready, pick-up before five on weekdays and before noon on Saturday. Anything else?'),
      caller('No, that is it. Thanks.'),
    ],
    result: {
      outcome: 'message', urgency: 'low', callerName: 'Olivia (Cascade Supply)',
      title: 'Tankless heater ready for pick-up',
      summary: 'Cascade Supply has the tankless heater from order 48213 ready. Pick-up before 5 pm on weekdays, before noon on Saturday.',
      actionItems: [{ text: 'Pick up order 48213 at Cascade Supply' }],
      fields: [{ label: 'Order', value: '48213' }],
    },
  },
  hangup: {
    from: '+15035550109',
    lines: [agent('{greeting}'), agent('Hello, are you still there?')],
    result: {
      outcome: 'hangup', urgency: 'low',
      title: 'Hung up before speaking',
      summary: 'The caller hung up after the greeting without saying anything.',
    },
  },
} satisfies Record<string, SimScript>

export type SimScriptName = keyof typeof simScripts
