import { expect, test, vi } from 'vitest'
import {
  CallLog,
  finalizeCall,
  finishCall,
  once,
  REPEAT_WINDOW_MS,
  repeatFilter,
  withCorrectedCallerLines,
} from './call-log.ts'
import type { CallSession } from './call-session.ts'
import type { CompleteJson } from './summary.ts'

const noWait = { wait: async () => {} }
const fakeCall = (finish = vi.fn(async () => {}), phone: string | null = null) =>
  ({
    callId: 'call_1',
    workspaceId: 'ws_1',
    contact: phone ? { phone } : null,
    append: vi.fn(async () => {}),
    finish,
  }) as unknown as CallSession & { finish: typeof finish }

const answer = JSON.stringify({
  title: 'Leak',
  summary: 'A leak.',
  outcome: 'callback',
  urgency: 'normal',
  action_items: ['Send a plumber'],
})

function talkedCall(call: CallSession) {
  const log = new CallLog(call)
  log.record('agent', 'How can I help?')
  log.record('caller', 'My sink is leaking.')
  log.messages.push('Call back about the sink')
  log.urgent = true
  return log
}

test('finishes with the summary; messages taken and the urgent flag are kept', async () => {
  const call = fakeCall(undefined, '+15035550142')
  const complete = vi.fn<CompleteJson>(async () => answer)
  await finishCall(call, talkedCall(call), complete, noWait)
  expect(complete.mock.calls[0]![1]).toContain('Action items already saved:\n- Call back about the sink')
  expect(call.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Leak',
      outcome: 'callback',
      urgency: 'urgent',
      actionItems: [{ text: 'Call back about the sink' }, { text: 'Send a plumber' }],
    }),
  )
})

test('a timed-out summary is not repeated; the message taken becomes title and summary', async () => {
  const call = fakeCall()
  const complete = vi.fn<CompleteJson>(async () => {
    throw new Error('The operation was aborted due to timeout')
  })
  await finishCall(call, talkedCall(call), complete, noWait)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(call.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Call back about the sink',
      summary: 'Call back about the sink',
      outcome: 'message',
      urgency: 'urgent',
      actionItems: [{ text: 'Call back about the sink' }],
    }),
  )
})

test('a failed summary request is tried once more', async () => {
  const call = fakeCall(undefined, '+15035550142')
  const complete = vi
    .fn<CompleteJson>()
    .mockRejectedValueOnce(new Error('summary request failed (429): Provider returned error'))
    .mockResolvedValue(answer)
  await finishCall(call, talkedCall(call), complete, noWait)
  expect(complete).toHaveBeenCalledTimes(2)
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leak', outcome: 'callback' }))
})

test('without a message taken, a failed summary finishes the call as answered', async () => {
  const call = fakeCall()
  const log = new CallLog(call)
  log.record('caller', 'Are you open on Sunday?')
  await finishCall(
    call,
    log,
    async () => {
      throw new Error('summary response was empty')
    },
    noWait,
  )
  expect(call.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Call (summary unavailable)',
      outcome: 'answered',
      summary: 'Are you open on Sunday?',
    }),
  )
})

test('a silent call after the voice failed is a call back, not a hang-up', async () => {
  const call = fakeCall(undefined, '+15035550142')
  const log = new CallLog(call)
  log.record('agent', 'Thanks for calling. How can I help?')
  log.voiceFailed = 'tts'
  const complete = vi.fn<CompleteJson>(async () => answer)
  await finishCall(call, log, complete, noWait)
  expect(complete).not.toHaveBeenCalled()
  expect(call.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Missed: the assistant's voice failed",
      outcome: 'callback',
      actionItems: [{ text: "Call the caller back: the assistant's voice failed on this call." }],
    }),
  )
  // Without caller ID there is no number to call back on: a message for the team that says what failed.
  const withheld = fakeCall()
  const silent = new CallLog(withheld)
  silent.voiceFailed = 'tts'
  await finishCall(withheld, silent, complete, noWait)
  expect(withheld.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: 'message',
      actionItems: [{ text: "The assistant's voice failed on this call." }],
    }),
  )
})

test('call.finish is retried until the API answers', async () => {
  const finish = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValue()
  const call = fakeCall(finish)
  await finishCall(call, talkedCall(call), async () => answer, noWait)
  expect(finish).toHaveBeenCalledTimes(3)
})

test('a recorded call asks the API to hold its news; a silent one does not', async () => {
  const call = fakeCall(vi.fn(async () => ({ held: true, named: true })) as never)
  const finished = await finishCall(call, talkedCall(call), async () => answer, noWait, true)
  expect(call.finish).toHaveBeenCalledWith(expect.objectContaining({ awaitTranscript: true }))
  expect(finished).toMatchObject({ held: true, named: true })

  const silent = fakeCall()
  const log = new CallLog(silent)
  log.record('agent', 'How can I help?')
  expect((await finishCall(silent, log, async () => answer, noWait, true)).held).toBe(false)
  expect(silent.finish).toHaveBeenCalledWith(expect.not.objectContaining({ awaitTranscript: true }))
})

const corrected = (lines: { speaker: 'agent' | 'caller'; text: string }[] | null, fail = false) =>
  vi.fn(async () => {
    if (fail) throw new Error('timed out')
    return lines ? { status: 'updated' as const, lines } : { status: 'skipped' as const }
  })

test('the corrected transcript is summarized again and replaces the first summary', async () => {
  const call = Object.assign(fakeCall(), {
    correctTranscript: corrected([
      { speaker: 'agent', text: 'How can I help?' },
      { speaker: 'caller', text: 'My sink is leaking badly.' },
    ]),
    finalize: vi.fn(async () => {}),
  })
  const log = talkedCall(call)
  const first = {
    title: 'Call in Korean',
    summary: 'Unclear.',
    outcome: 'answered' as const,
    urgency: 'normal' as const,
    actionItems: [{ text: 'Listen again' }],
    callerName: 'Oh',
  }
  const complete = vi.fn<CompleteJson>(async () => answer)
  await finalizeCall(call, log, complete, { held: true, result: first, named: true }, true, noWait)
  expect(complete.mock.calls[0]![1]).toContain('My sink is leaking badly.')
  expect(call.finalize).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Leak',
      urgency: 'urgent',
      actionItems: [{ text: 'Call back about the sink' }, { text: 'Send a plumber' }],
      previous: {
        actionItems: ['Listen again'],
        callerName: 'Oh',
        urgency: 'normal',
        title: 'Call in Korean',
        summary: 'Unclear.',
      },
    }),
  )

  // A name finish did not write (the contact had one) is not sent as the one to correct.
  const other = Object.assign(fakeCall(), {
    correctTranscript: corrected([{ speaker: 'caller', text: 'My sink is leaking badly.' }]),
    finalize: vi.fn(async () => {}),
  })
  await finalizeCall(other, talkedCall(other), complete, { held: true, result: first }, true, noWait)
  expect(other.finalize).toHaveBeenCalledWith(
    expect.objectContaining({
      previous: { actionItems: ['Listen again'], urgency: 'normal', title: 'Call in Korean', summary: 'Unclear.' },
    }),
  )
})

test("the corrected caller lines replace the agent's own in order; a different number of them keeps the first summary", () => {
  const own = [
    { speaker: 'agent' as const, text: 'Hi.' },
    { speaker: 'caller' as const, text: 'leak in the bay' },
    { speaker: 'agent' as const, text: 'Your number?' },
    { speaker: 'caller' as const, text: '503' },
  ]
  expect(
    withCorrectedCallerLines(own, [
      { speaker: 'caller', text: 'Leak in the bathroom.' },
      { speaker: 'agent', text: 'Your number?' },
      { speaker: 'caller', text: '503-555-0142' },
    ]),
  ).toEqual([
    own[0],
    { speaker: 'caller', text: 'Leak in the bathroom.' },
    own[2],
    { speaker: 'caller', text: '503-555-0142' },
  ])
  expect(withCorrectedCallerLines(own, [{ speaker: 'caller', text: 'Leak in the bathroom.' }])).toBeNull()
  expect(withCorrectedCallerLines(own, [])).toBeNull()
})

test('without a corrected transcript the news goes with the first summary', async () => {
  for (const [correctTranscript, saved] of [
    [corrected(null), true],
    [corrected(null, true), true],
    [corrected([{ speaker: 'caller', text: 'x' }]), false],
  ] as const) {
    const call = Object.assign(fakeCall(), { correctTranscript, finalize: vi.fn(async () => {}) })
    const complete = vi.fn<CompleteJson>(async () => answer)
    await finalizeCall(call, talkedCall(call), complete, { held: true, result: { outcome: 'answered' } }, saved, noWait)
    expect(complete).not.toHaveBeenCalled()
    expect(call.finalize).toHaveBeenCalledWith({})
  }
  // A failed second summary keeps the first one too.
  const call = Object.assign(fakeCall(), {
    correctTranscript: corrected([{ speaker: 'caller', text: 'x' }]),
    finalize: vi.fn(async () => {}),
  })
  await finalizeCall(
    call,
    talkedCall(call),
    async () => {
      throw new Error('The operation was aborted due to timeout')
    },
    { held: true, result: {} },
    true,
    noWait,
  )
  expect(call.finalize).toHaveBeenCalledWith({})
})

test('once runs the finish a single time and never rejects', async () => {
  const finish = vi.fn(async () => {
    throw new Error('API down')
  })
  const finishOnce = once(finish, 'could not finish call call_1')
  await expect(Promise.all([finishOnce(), finishOnce(), finishOnce()])).resolves.toBeDefined()
  expect(finish).toHaveBeenCalledTimes(1)
})

test('the reply times go out at hang-up with the pipeline and providers; a failure there does not stop the finish', async () => {
  const call = fakeCall()
  const recordTimings = vi.fn(async () => {
    throw new Error('API down')
  })
  Object.assign(call, { recordTimings })
  const log = new CallLog(call)
  log.timing = { pipeline: 'realtime', providers: { turn: 'openai_realtime', model: 'openai_realtime' } }
  log.replies.push({ at: '2026-11-12T18:00:00.000Z', turnMs: 500, modelMs: 300, serverMs: 20, totalMs: 820 })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await finishCall(call, log, async () => '{"title":"t","summary":"s","outcome":"answered"}', noWait)
  expect(recordTimings).toHaveBeenCalledWith({
    pipeline: 'realtime',
    providers: { turn: 'openai_realtime', model: 'openai_realtime' },
    replies: log.replies,
  })
  expect(call.finish).toHaveBeenCalled()
  warn.mockRestore()
})

test('a line the session reports twice is written once: same item, or same words from the same speaker soon after', () => {
  let t = 0
  const repeated = repeatFilter(() => t)
  expect(repeated({ id: 'a', role: 'assistant', text: 'Thanks for calling, goodbye!' })).toBe(false)
  t = 900
  expect(repeated({ id: 'b', role: 'assistant', text: 'Thanks for calling, goodbye! ' })).toBe(true)
  expect(repeated({ id: 'a', role: 'assistant', text: 'Thanks for calling, goodbye!' })).toBe(true)
  // The caller saying the same, or the assistant saying it again later, is a new line.
  expect(repeated({ id: 'c', role: 'user', text: 'Thanks for calling, goodbye!' })).toBe(false)
  t += REPEAT_WINDOW_MS + 1
  expect(repeated({ id: 'd', role: 'assistant', text: 'Thanks for calling, goodbye!' })).toBe(false)
  expect(repeated({ id: 'e', role: 'assistant', text: 'Is there anything else?' })).toBe(false)
})
