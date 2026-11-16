// The LLM test suite's own tests (LIN-391), without a model: the deterministic checks, the case catalogue, and the
// tools built from the real definitions.
import { describe, expect, it } from 'vitest'
import { CASES, CATEGORIES, neededPasses } from './cases.ts'
import { globalProblems, languageOf, runCheck, sentencesOf } from './checks.ts'
import type { CallEvent, Transcript } from './conversation.ts'
import { JOB_STATUS_LOOKUP, MIKE, setup } from './setups.ts'
import { buildTools, openAiTools, parseArgs } from './tools.ts'

const transcript = (events: CallEvent[], over: Partial<Transcript> = {}): Transcript => ({
  events,
  ended: false,
  endedBy: null,
  urgent: false,
  instructions: '',
  ...over,
})
const say = (turn: number, text: string, response = turn): CallEvent => ({ kind: 'assistant', turn, text, response })
const tool = (
  turn: number,
  name: string,
  args: Record<string, unknown> = {},
  response = turn,
  result = 'ok',
): CallEvent => ({ kind: 'tool', turn, name, args, raw: JSON.stringify(args), result, response })

describe('checks', () => {
  it('splits spoken sentences, not abbreviations or times', () => {
    expect(sentencesOf('Sure. We open at 7 a.m. tomorrow. Mr. Brennan will call!')).toHaveLength(3)
    expect(sentencesOf('Hi there')).toEqual(['Hi there'])
  })

  it('tells the language of a reply by its common words', () => {
    expect(languageOf('I can only help in English, but I can take a message for you.')).toBe('en')
    expect(languageOf('Ich kann Ihnen leider nur auf Englisch helfen, aber gerne eine Nachricht aufnehmen.')).toBe('de')
    expect(languageOf('Lo siento, solo puedo ayudar en inglés, pero puedo tomar un mensaje.')).toBe('es')
    expect(languageOf('Okay')).toBeNull()
  })

  it('checks tools, their order, arguments and results', () => {
    const t = transcript([
      say(1, 'Let me check.'),
      tool(1, 'get_name'),
      tool(2, 'book_appointment', { start: 's3' }, 2, 'Booked Thursday, November 19 at 9:00 AM.'),
    ])
    expect(runCheck({ type: 'tool', tool: 'get_name', byTurn: 1 }, t)).toBeNull()
    expect(runCheck({ type: 'tool', tool: 'book_appointment', byTurn: 1 }, t)).toMatch(/not called by turn 1/)
    expect(runCheck({ type: 'tool', tool: 'book_appointment', args: { start: /s3/ } }, t)).toBeNull()
    expect(runCheck({ type: 'tool', tool: 'book_appointment', args: { start: /s1/ } }, t)).toMatch(/not with/)
    expect(runCheck({ type: 'toolResult', tool: 'book_appointment', pattern: /November 19/ }, t)).toBeNull()
    expect(runCheck({ type: 'firstTool', tool: 'get_name' }, t)).toBeNull()
    expect(runCheck({ type: 'notBefore', tool: 'book_appointment', before: 'get_name' }, t)).toBeNull()
    expect(runCheck({ type: 'notBefore', tool: 'book_appointment', before: 'get_address' }, t)).toMatch(/never called/)
    expect(runCheck({ type: 'noTool', tool: ['transfer_call', 'get_name'] }, t)).toMatch(/get_name called/)
  })

  it('checks what was said, by turn', () => {
    const t = transcript([say(1, 'We are open until 5 PM.'), say(2, 'Is there anything else? And your name?')])
    expect(runCheck({ type: 'say', pattern: /5 PM/, turn: 1 }, t)).toBeNull()
    expect(runCheck({ type: 'say', pattern: /5 PM/, turn: 2 }, t)).toMatch(/no reply matches/)
    expect(runCheck({ type: 'notSay', pattern: /\?[^?]+\?/ }, t)).toMatch(/turn 2/)
    expect(runCheck({ type: 'notSay', pattern: /\?[^?]+\?/, turn: { from: 3 } }, t)).toBeNull()
    expect(runCheck({ type: 'maxSentences', max: 1 }, t)).toMatch(/turn 2 has 2 sentences/)
    expect(runCheck({ type: 'language', lang: 'en' }, t)).toBeNull()
  })

  it('checks how the call ended and the urgent flag', () => {
    const t = transcript([], { ended: true, endedBy: 'end_call', urgent: true })
    expect(runCheck({ type: 'ended', value: true }, t)).toBeNull()
    expect(runCheck({ type: 'ended', value: false }, t)).toMatch(/ended/)
    expect(runCheck({ type: 'urgent', value: false }, t)).toBe('flagged as urgent')
  })

  it('finds markdown, emojis, end_call with another tool, and refused tool calls on every call', () => {
    const t = transcript([
      say(1, '**Sure!** Here you go 🙂'),
      say(2, 'We offer:\n- drains\n- heaters'),
      tool(3, 'end_call', {}, 7),
      tool(3, 'flag_urgent', {}, 7),
      { ...(tool(4, 'get_name') as Extract<CallEvent, { kind: 'tool' }>), error: true, result: 'Invalid arguments' },
    ])
    const problems = globalProblems(t)
    expect(problems.filter(p => p.startsWith('markdown'))).toHaveLength(2)
    expect(problems.some(p => p.startsWith('emoji'))).toBe(true)
    expect(problems.some(p => p.includes('end_call in the same response as flag_urgent'))).toBe(true)
    expect(problems.some(p => p.startsWith('tool call refused'))).toBe(true)
    expect(globalProblems(transcript([say(1, 'Sure, we can help with that.')]))).toEqual([])
  })

  it('needs every run for a must case and two in three for a should case', () => {
    expect(neededPasses('must', 3)).toBe(3)
    expect(neededPasses('should', 3)).toBe(2)
    expect(neededPasses('should', 5)).toBe(4)
  })
})

describe('cases', () => {
  it('has 50 or more cases with unique, well-formed ids', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50)
    const ids = CASES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of CASES) {
      expect(c.id).toMatch(/^[a-z]+(-[a-z0-9]+)+$/)
      expect(c.id.startsWith(`${c.category}-`), c.id).toBe(true)
      expect(c.title.trim(), c.id).not.toBe('')
      expect(c.why.trim(), c.id).not.toBe('')
    }
  })

  it('covers every category', () => {
    for (const cat of CATEGORIES)
      expect(
        CASES.some(c => c.category === cat),
        cat,
      ).toBe(true)
  })

  it('gives every case a script and something to grade', () => {
    for (const c of CASES) {
      expect(!!c.turns?.length !== !!c.caller, `${c.id}: turns or a simulated caller, not both`).toBe(true)
      expect(c.checks.length + (c.judge?.must?.length ?? 0) + (c.judge?.mustNot?.length ?? 0), c.id).toBeGreaterThan(0)
    }
  })

  it('names only tools the case has in its checks', () => {
    for (const c of CASES) {
      const names = Object.keys(buildTools(c.setup, c.sim).tools)
      // A tool the case does not have can still be named as one that must not be called.
      for (const check of c.checks) {
        if (check.type === 'tool' || check.type === 'firstTool' || check.type === 'toolResult')
          expect(names, `${c.id}: ${check.tool}`).toContain(check.tool)
        if (check.type === 'notBefore') expect(names, `${c.id}: ${check.before}`).toContain(check.before)
      }
    }
  })
})

describe('tools', () => {
  it('builds the real tools as OpenAI function schemas, sorted by name', () => {
    const s = setup({ booking: true, transfers: [MIKE], lookups: [JOB_STATUS_LOOKUP] })
    const { tools } = buildTools(s)
    const schemas = openAiTools(tools)
    const names = schemas.map(t => t.function.name)
    expect(names).toEqual([...names].sort())
    expect(names).toEqual(
      expect.arrayContaining([
        'book_appointment',
        'end_call',
        'find_slots',
        'flag_urgent',
        'get_name',
        'lookup_job_status',
        'transfer_call',
      ]),
    )
    expect(names).not.toContain('get_phone_number')
    for (const t of schemas) {
      expect(t.function.description, t.function.name).toBeTruthy()
      expect(t.function.parameters.type).toBe('object')
      expect(t.function.parameters.$schema).toBeUndefined()
    }
  })

  it('gives get_phone_number only without caller ID', () => {
    expect(Object.keys(buildTools(setup({ caller: 'withheld' })).tools)).toContain('get_phone_number')
    expect(Object.keys(buildTools(setup()).tools)).not.toContain('get_phone_number')
  })

  it('reads arguments with the tool schema', () => {
    const { tools } = buildTools(setup({ booking: true }))
    expect(parseArgs(tools.find_slots!, '{"appointment_type_id":"at_repair"}')).toMatchObject({ ok: true })
    expect(parseArgs(tools.find_slots!, '{"appointment_type_id":')).toMatchObject({ ok: false })
    expect(parseArgs(tools.find_slots!, '{}')).toMatchObject({ ok: false })
  })
})
