import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_SILENCE_CLOSING } from '@linedesk/actions'
import { voice } from '@livekit/agents'
import { EventEmitter } from 'node:events'
import { asksCaller, greetingPlayed, hangUpAfterGoodbye, nextReplyOf, skipSecondGoodbye, hangUpAfterLine, hangUpAtCallLimit, remindOnSilence, type Reply, silencePolicyOf, silenceSchedule, announcesHangUp, withoutEndCall, writesEndCall } from './hang-up.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A reply that has played once `play()` is called; `words`: what the assistant said in it. */
function reply(words = '') {
  let finished = false
  const callbacks: (() => void)[] = []
  const item = { type: 'message', role: 'assistant', textContent: words }
  const play = () => {
    finished = true
    for (const callback of callbacks) callback()
  }
  return { play, reply: { done: () => finished, addDoneCallback: c => void callbacks.push(c), chatItems: words ? [item] : [] } as Reply }
}

test('end_call: the call ends shortly after the goodbye reply has played, not during it', async () => {
  const toolReply = reply()
  const goodbye = reply("Alright, I'll hang up now. Thanks for calling, goodbye!")
  const hangUp = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  const stopListening = vi.fn()
  void hangUpAfterGoodbye({ toolReply: toolReply.reply, nextReply: async () => goodbye.reply, sayGoodbye, stopListening, hangUp })
  expect(stopListening).not.toHaveBeenCalled() // a "bye" the caller is still saying must end first
  toolReply.play()
  await vi.advanceTimersByTimeAsync(3000)
  expect(stopListening).toHaveBeenCalledOnce()
  expect(hangUp).not.toHaveBeenCalled()
  goodbye.play()
  await vi.advanceTimersByTimeAsync(399)
  expect(hangUp).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(hangUp).toHaveBeenCalledOnce()
  expect(sayGoodbye).not.toHaveBeenCalled()
})

test('end_call said with the goodbye in the same reply: no second goodbye, the call ends after it', async () => {
  const toolReply = reply('Thanks for calling, goodbye!')
  const hangUp = vi.fn()
  const nextReply = vi.fn(async () => null)
  const sayGoodbye = vi.fn(async () => {})
  void hangUpAfterGoodbye({ toolReply: toolReply.reply, nextReply, sayGoodbye, hangUp })
  toolReply.play()
  await vi.advanceTimersByTimeAsync(400)
  expect(hangUp).toHaveBeenCalledOnce()
  expect(nextReply).not.toHaveBeenCalled()
  expect(sayGoodbye).not.toHaveBeenCalled()
})

// Seen over the phone (realtime model): end_call came without words, no goodbye followed, and the line dropped in silence.
test('end_call without any goodbye from the model: the goodbye line is said first, the call never ends in silence', async () => {
  const toolReply = reply()
  const hangUp = vi.fn()
  let played: () => void = () => {}
  const sayGoodbye = vi.fn(() => new Promise<void>(resolve => (played = resolve)))
  void hangUpAfterGoodbye({ toolReply: toolReply.reply, nextReply: async () => null, sayGoodbye, hangUp })
  toolReply.play()
  await vi.advanceTimersByTimeAsync(0)
  expect(sayGoodbye).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5000)
  expect(hangUp).not.toHaveBeenCalled()
  played()
  await vi.advanceTimersByTimeAsync(400)
  expect(hangUp).toHaveBeenCalledOnce()
})

test('a reply after end_call without words also gets the goodbye line', async () => {
  const toolReply = reply()
  const empty = reply()
  const hangUp = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  void hangUpAfterGoodbye({ toolReply: toolReply.reply, nextReply: async () => empty.reply, sayGoodbye, hangUp })
  toolReply.play()
  empty.play()
  await vi.advanceTimersByTimeAsync(400)
  expect(sayGoodbye).toHaveBeenCalledOnce()
  expect(hangUp).toHaveBeenCalledOnce()
})

test('the hang-up line has played already: the call ends after the pause, nothing more is said', async () => {
  const hangUp = vi.fn()
  const nextReply = vi.fn(async () => null)
  const sayGoodbye = vi.fn(async () => {})
  void hangUpAfterGoodbye({ toolReply: null, goodbyeSaid: true, nextReply, sayGoodbye, hangUp })
  await vi.advanceTimersByTimeAsync(400)
  expect(hangUp).toHaveBeenCalledOnce()
  expect(nextReply).not.toHaveBeenCalled()
  expect(sayGoodbye).not.toHaveBeenCalled()
})

test('a goodbye that never finishes playing is cut at the cap, once', async () => {
  const stuck = reply()
  const hangUp = vi.fn()
  void hangUpAfterGoodbye({ toolReply: stuck.reply, nextReply: async () => null, sayGoodbye: async () => {}, hangUp, maxMs: 20_000 })
  await vi.advanceTimersByTimeAsync(19_999)
  expect(hangUp).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(hangUp).toHaveBeenCalledOnce()
  stuck.play()
  await vi.advanceTimersByTimeAsync(1000)
  expect(hangUp).toHaveBeenCalledOnce()
})

// LIN-341: the caller agreed to leave a message, and the model called end_call while it asked for the message.
test('asksCaller: a question or a request to the caller, never a goodbye', () => {
  expect(asksCaller('Please briefly tell me what you want the team to know about your order.')).toBe(true)
  expect(asksCaller("Sure. What's the best number to reach you?")).toBe(true)
  expect(asksCaller('Go ahead.')).toBe(true)
  expect(asksCaller('Bitte sagen Sie mir, was ich dem Team ausrichten soll.')).toBe(true)
  expect(asksCaller('¿Algo más en lo que pueda ayudarle?')).toBe(true)
  expect(asksCaller('还有什么可以帮您的吗？')).toBe(true)
  expect(asksCaller("Alright, I'll hang up now. Thanks for calling, goodbye!")).toBe(false)
  expect(asksCaller('Thanks for calling. Have a great day!')).toBe(false)
  expect(asksCaller('Anything else? No? Then goodbye!')).toBe(false)
  expect(asksCaller("I've noted that for the team.")).toBe(false)
  expect(asksCaller('')).toBe(false)
})

test('end_call in a reply that asks the caller something: no hang-up, the call goes on', async () => {
  const asked = reply('Please briefly tell me what you want the team to know about your order.')
  const hangUp = vi.fn()
  const nextReply = vi.fn(async () => null)
  const sayGoodbye = vi.fn(async () => {})
  const result = hangUpAfterGoodbye({ toolReply: asked.reply, nextReply, sayGoodbye, hangUp })
  asked.play()
  await expect(result).resolves.toBe(false)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(hangUp).not.toHaveBeenCalled()
  expect(nextReply).not.toHaveBeenCalled()
  expect(sayGoodbye).not.toHaveBeenCalled()
})

test('a realtime goodbye reply that asks the caller something: no hang-up either', async () => {
  const silent = reply()
  const question = reply('Before you go, is the number you are calling from the best one?')
  const hangUp = vi.fn()
  const result = hangUpAfterGoodbye({ toolReply: silent.reply, nextReply: async () => question.reply, sayGoodbye: async () => {}, hangUp })
  silent.play()
  question.play()
  await expect(result).resolves.toBe(false)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(hangUp).not.toHaveBeenCalled()
})

test('nextReplyOf: the first reply after end_call, also when it starts before it is asked for; null when none starts', async () => {
  const session = new EventEmitter()
  const toolReply = reply().reply
  const goodbye = reply('Goodbye!').reply
  const next = nextReplyOf(session as unknown as voice.AgentSession, toolReply)
  session.emit(voice.AgentSessionEventTypes.SpeechCreated, { speechHandle: toolReply })
  session.emit(voice.AgentSessionEventTypes.SpeechCreated, { speechHandle: goodbye })
  await expect(next(5000)).resolves.toBe(goodbye)

  const none = nextReplyOf(new EventEmitter() as unknown as voice.AgentSession, toolReply)(5000)
  await vi.advanceTimersByTimeAsync(5000)
  await expect(none).resolves.toBeNull()
})

// Seen on realtime call tests: the caller's "No thanks" reached the transcript only after end_call ran, so "the assistant
// spoke since the caller" was still true from its question, and the goodbye after end_call was skipped.
test('skipSecondGoodbye: the reply to end_call is skipped only when a goodbye was said already', () => {
  const session = new EventEmitter()
  let said = false
  skipSecondGoodbye(session as unknown as voice.AgentSession, () => said)
  const executed = (...names: string[]) => {
    const event = { functionCalls: names.map(name => ({ name })), cancelToolReply: vi.fn() }
    session.emit(voice.AgentSessionEventTypes.FunctionToolsExecuted, event)
    return event.cancelToolReply
  }
  expect(executed('end_call')).not.toHaveBeenCalled()
  said = true
  expect(executed('end_call')).toHaveBeenCalledOnce()
  expect(executed('take_message')).not.toHaveBeenCalled()
})

function userStates() {
  const listeners: ((ev: { newState: string }) => void)[] = []
  const session = { on: (event: string, listener: (ev: { newState: string }) => void) => event === voice.AgentSessionEventTypes.UserStateChanged && listeners.push(listener) }
  return { session: session as never, emit: (newState: string) => listeners.forEach(l => l({ newState })) }
}

test('silence settings: defaults on (every 5 s, 2 reminders, hang-up at 15 s, the default closing), each from the assistant when set', () => {
  expect(silencePolicyOf(null)).toEqual({ firstGapS: 5, reminders: 2, hangUpS: 15, reminder: null, closing: DEFAULT_SILENCE_CLOSING })
  expect(silencePolicyOf({ silence_first_gap_s: 8, silence_reminders: 0, silence_hang_up_s: 30, silence_reminder: ' Hallo? ', silence_closing: '  Bye now.  ' })).toEqual({ firstGapS: 8, reminders: 0, hangUpS: 30, reminder: 'Hallo?', closing: 'Bye now.' })
  expect(silencePolicyOf({ silence_reminder: '  ' }).reminder).toBeNull()
  expect(silencePolicyOf({ silence_closing: ' ' }).closing).toBe(DEFAULT_SILENCE_CLOSING)
  // Asks at 5 and 10 s of silence, the closing line at 15 s.
  expect(silenceSchedule({ firstGapS: 5, reminders: 2, hangUpS: 15 })).toEqual([5, 10, 15])
  expect(silenceSchedule({ firstGapS: 5, reminders: 0, hangUpS: 15 })).toEqual([15])
  // A hang-up time not after the last reminder (an older API sends none): one gap after it.
  expect(silenceSchedule({ firstGapS: 8, reminders: 2, hangUpS: 15 })).toEqual([8, 16, 24])
})

const policy = { firstGapS: 5, reminders: 2, hangUpS: 15 }

test('silence: a reminder every gap, then the closing line at the hang-up time, once', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  // The session reports "away" after the first gap (its away timeout): 5 s.
  remindOnSilence(session, policy, { remind, close, transferred: () => false })
  emit('away')
  expect(remind).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(5_000 - 1)
  expect(remind).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(1)
  expect(remind).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(5_000 - 1)
  expect(close).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(close).toHaveBeenCalledOnce()
  emit('away')
  vi.advanceTimersByTime(120_000)
  expect(close).toHaveBeenCalledOnce()
  expect(remind).toHaveBeenCalledTimes(2)
})

test('a call that ended during the silence (the caller hung up): no reminder, no closing line afterwards', () => {
  // Production, 2026-11-15: the browser hung up at 26 s, one reminder in; the timer still fired at 31 s, wrote "Hung up
  // after silence on the line" after the call's end and tried to say the closing line on the closed session.
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  const stop = remindOnSilence(session, policy, { remind, close, transferred: () => false })
  emit('away')
  expect(remind).toHaveBeenCalledTimes(1)
  stop()
  vi.advanceTimersByTime(120_000)
  emit('away')
  vi.advanceTimersByTime(120_000)
  expect(remind).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
})

test('a call that ends before the greeting has played never starts the silence schedule', async () => {
  const { session, emit } = userStates()
  const close = vi.fn()
  let greet = () => {}
  const greeted = new Promise<void>(resolve => (greet = resolve))
  const stop = remindOnSilence(session, policy, { remind: vi.fn(), close, transferred: () => false, greeted })
  emit('away')
  stop()
  greet()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(close).not.toHaveBeenCalled()
})

test('a caller who answers stays on, and the reminders start over at the next silence', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  remindOnSilence(session, policy, { remind, close, transferred: () => false })
  emit('away')
  vi.advanceTimersByTime(5_000) // second reminder
  emit('speaking')
  vi.advanceTimersByTime(120_000)
  expect(close).not.toHaveBeenCalled()
  emit('listening')
  emit('away')
  expect(remind).toHaveBeenCalledTimes(3)
  vi.advanceTimersByTime(5_000 + 5_000)
  expect(remind).toHaveBeenCalledTimes(4)
  expect(close).toHaveBeenCalledOnce()
})

test('no reminders: the closing line at the hang-up time', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  remindOnSilence(session, { ...policy, reminders: 0 }, { remind, close, transferred: () => false })
  emit('away') // at 5 s
  vi.advanceTimersByTime(10_000 - 1)
  expect(close).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(remind).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test('never during or after a transfer: no reminder, no closing line, the call stays up', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  let transferred = false
  remindOnSilence(session, policy, { remind, close, transferred: () => transferred })
  emit('away')
  transferred = true // put through while the reminders run
  vi.advanceTimersByTime(60 * 60_000)
  emit('listening')
  emit('away')
  vi.advanceTimersByTime(60 * 60_000)
  expect(remind).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})

test('the assistant says goodbye at its time limit, unless the call was put through to a person', () => {
  const goodbye = vi.fn()
  hangUpAtCallLimit(25 * 60_000, { goodbye, transferred: () => false })
  vi.advanceTimersByTime(25 * 60_000 - 1)
  expect(goodbye).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(goodbye).toHaveBeenCalledOnce()

  const notAfterTransfer = vi.fn()
  hangUpAtCallLimit(25 * 60_000, { goodbye: notAfterTransfer, transferred: () => true })
  const cancelled = vi.fn()
  hangUpAtCallLimit(25 * 60_000, { goodbye: cancelled, transferred: () => false })()
  vi.advanceTimersByTime(30 * 60_000)
  expect(notAfterTransfer).not.toHaveBeenCalled()
  expect(cancelled).not.toHaveBeenCalled()
})

test('a fixed line hangs up once it has played, or at the latest after the cap', async () => {
  const played = vi.fn()
  hangUpAfterLine(Promise.resolve(), played)
  await vi.advanceTimersByTimeAsync(0)
  expect(played).toHaveBeenCalledOnce()

  const stuck = vi.fn()
  hangUpAfterLine(new Promise(() => {}), stuck, 15_000)
  await vi.advanceTimersByTimeAsync(14_999)
  expect(stuck).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(stuck).toHaveBeenCalledOnce()

  const failed = vi.fn()
  hangUpAfterLine(Promise.reject(new Error('tts down')), failed)
  await vi.advanceTimersByTimeAsync(0)
  expect(failed).toHaveBeenCalledOnce()
})

test('on hold while a transfer rings: no reminder and no closing line; after the hold the reminders start over', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  let onHold = true
  remindOnSilence(session, policy, { remind, close, transferred: () => false, onHold: () => onHold })
  emit('away') // quiet while it rings
  vi.advanceTimersByTime(90_000)
  expect(remind).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  onHold = false // nobody took it; the caller stays silent
  vi.advanceTimersByTime(5_000)
  expect(remind).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(5_000 + 5_000)
  expect(remind).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
})

test('a greeting slow to start: no reminder and no closing line before it has played; the silence counts from its end', async () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  let played!: () => void
  const greeted = new Promise<void>(resolve => (played = resolve))
  remindOnSilence(session, policy, { remind, close, transferred: () => false, greeted })
  // A busy server: the caller is "away" at 5 s, the greeting only plays after 38 s.
  emit('away')
  await vi.advanceTimersByTimeAsync(38_000)
  expect(remind).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  played()
  // The session reports no new "away" (the caller still is): the whole schedule runs from the greeting's end.
  await vi.advanceTimersByTimeAsync(5_000 - 1)
  expect(remind).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(remind).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(10_000 - 1)
  expect(close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(remind).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
})

test('a caller who speaks before the greeting has played is not away when it ends: the session\'s next "away" starts the count', async () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  let played!: () => void
  remindOnSilence(session, policy, { remind, close, transferred: () => false, greeted: new Promise<void>(resolve => (played = resolve)) })
  emit('away')
  emit('speaking') // "Hello?"
  emit('listening')
  played()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(remind).not.toHaveBeenCalled()
  emit('away') // the session's away timeout, counted from the end of the greeting
  expect(remind).toHaveBeenCalledOnce()
})

function agentStates() {
  const listeners = new Set<(ev: { oldState: string }) => void>()
  const session = {
    on: (_: string, listener: (ev: { oldState: string }) => void) => listeners.add(listener),
    off: (_: string, listener: (ev: { oldState: string }) => void) => listeners.delete(listener),
  }
  return { session: session as never, emit: (oldState: string) => [...listeners].forEach(l => l({ oldState })), listeners }
}

test('the greeting has played once the first speech ended, or at the latest after the cap', async () => {
  const { session, emit, listeners } = agentStates()
  const played = vi.fn()
  void greetingPlayed(session, 60_000).then(played)
  emit('initializing') // listening
  emit('listening') // thinking
  emit('thinking') // speaking: the greeting plays
  await vi.advanceTimersByTimeAsync(0)
  expect(played).not.toHaveBeenCalled()
  emit('speaking') // listening: it has played
  await vi.advanceTimersByTimeAsync(0)
  expect(played).toHaveBeenCalledOnce()
  expect(listeners.size).toBe(0)

  const never = agentStates()
  const capped = vi.fn()
  void greetingPlayed(never.session, 60_000).then(capped)
  await vi.advanceTimersByTimeAsync(60_000 - 1)
  expect(capped).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(capped).toHaveBeenCalledOnce()
  expect(never.listeners.size).toBe(0)
})

test('end_call written into the goodbye counts as the hang-up and is left out of the transcript', () => {
  const goodbye = "Alright, I'll hang up now. Thanks for calling, goodbye! \n\n{end_call}"
  expect(writesEndCall(goodbye)).toBe(true)
  expect(writesEndCall('I can end the call for you, or take a message.')).toBe(false)
  expect(withoutEndCall(goodbye)).toBe("Alright, I'll hang up now. Thanks for calling, goodbye!")
  expect(withoutEndCall('end_call')).toBe('')
  // Seen on a realtime call: the transcript kept "<>" after the goodbye.
  for (const written of ['<end_call>', '[end_call]', '{{end_call}}', '<end_call()>', 'end_call()']) {
    expect(writesEndCall(`Thanks for calling, goodbye!\n\n${written}`)).toBe(true)
    expect(withoutEndCall(`Thanks for calling, goodbye!\n\n${written}`)).toBe('Thanks for calling, goodbye!')
  }
})

test('the hang-up line counts as the hang-up; a question or a negation does not', () => {
  for (const said of [
    "Alright, I'll hang up now. Thanks for calling, goodbye!",
    'Alright, I’ll hang up now. Thanks for calling, goodbye!',
    'Okay, I will hang up now. Have a great day!',
    'No problem, I’ll hang up now. Goodbye!',
    'Perfecto, voy a colgar ahora. ¡Adiós!',
    'Alles klar, ich lege jetzt auf. Auf Wiederhören!',
    'Très bien, je vais raccrocher. Au revoir !',
  ]) expect(announcesHangUp(said), said).toBe(true)
  for (const said of [
    'Please don\'t hang up, I will check that for you.',
    'Shall I hang up now?',
    'Please don’t hang up yet, I’ll check.',
    'I won\'t hang up until we have your address.',
    'Is there anything else I can help with?',
  ]) expect(announcesHangUp(said), said).toBe(false)
})
