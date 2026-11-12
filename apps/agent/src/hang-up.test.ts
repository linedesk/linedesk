import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_SILENCE_CLOSING } from '@linedesk/actions'
import { voice } from '@livekit/agents'
import { greetingPlayed, hangUpAfterLine, hangUpAfterSpeech, hangUpAtCallLimit, remindOnSilence, silencePolicyOf, silenceSchedule, announcesHangUp, withoutEndCall, writesEndCall } from './hang-up.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const agent = (agentState: string, { spoke = false, onDone = (_: () => void) => {} } = {}) => ({ agentState, onDone, spokeWithin: () => spoke })

test('hangs up shortly after the goodbye has played, not during it', () => {
  let done: () => void = () => {}
  const hangUp = vi.fn()
  hangUpAfterSpeech(agent('speaking', { onDone: l => (done = l) }), hangUp)
  vi.advanceTimersByTime(2000)
  expect(hangUp).not.toHaveBeenCalled()
  done()
  vi.advanceTimersByTime(400)
  expect(hangUp).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(10_000)
  expect(hangUp).toHaveBeenCalledOnce()
})

test('end_call right after the goodbye played hangs up without another word; a stuck goodbye is cut at the cap', () => {
  const quiet = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  hangUpAfterSpeech(agent('listening', { spoke: true }), quiet, sayGoodbye)
  vi.advanceTimersByTime(1900)
  expect(quiet).toHaveBeenCalledOnce()
  expect(sayGoodbye).not.toHaveBeenCalled()

  const stuck = vi.fn()
  hangUpAfterSpeech(agent('speaking'), stuck, undefined, { maxMs: 6000 })
  vi.advanceTimersByTime(5999)
  expect(stuck).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(stuck).toHaveBeenCalledOnce()
})

// Seen on a realtime call test: the hang-up line was added once it had played, the call waited 1.5 s more, the caller
// said goodbye in that time and the assistant answered with another goodbye before the line was cut.
test('after the hang-up line has played the call ends at once; while it still plays, after it', () => {
  const hangUp = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  hangUpAfterSpeech(agent('listening', { spoke: true }), hangUp, sayGoodbye, { goodbyeSaid: true })
  vi.advanceTimersByTime(400)
  expect(hangUp).toHaveBeenCalledOnce()
  expect(sayGoodbye).not.toHaveBeenCalled()

  let done: () => void = () => {}
  const playing = vi.fn()
  hangUpAfterSpeech(agent('speaking', { spoke: true, onDone: l => (done = l) }), playing, sayGoodbye, { goodbyeSaid: true })
  vi.advanceTimersByTime(1000)
  expect(playing).not.toHaveBeenCalled()
  done()
  vi.advanceTimersByTime(400)
  expect(playing).toHaveBeenCalledOnce()
})

test('end_call with nothing said before: the assistant says goodbye first, never ends in silence', async () => {
  const hangUp = vi.fn()
  let played: () => void = () => {}
  const sayGoodbye = vi.fn(() => new Promise<void>(resolve => (played = resolve)))
  hangUpAfterSpeech(agent('listening'), hangUp, sayGoodbye)
  await vi.advanceTimersByTimeAsync(1500)
  expect(sayGoodbye).toHaveBeenCalledOnce()
  expect(hangUp).not.toHaveBeenCalled()
  played()
  await vi.advanceTimersByTimeAsync(0)
  expect(hangUp).toHaveBeenCalledOnce()
})

test('end_call while the model still thinks up its goodbye: waits for it and adds no goodbye of its own', () => {
  let done: () => void = () => {}
  let spoke = false
  const hangUp = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  hangUpAfterSpeech({ agentState: 'thinking', onDone: l => (done = l), spokeWithin: () => spoke }, hangUp, sayGoodbye)
  vi.advanceTimersByTime(1500)
  expect(hangUp).not.toHaveBeenCalled()
  spoke = true // "Goodbye." played
  done()
  vi.advanceTimersByTime(400)
  expect(hangUp).toHaveBeenCalledOnce()
  expect(sayGoodbye).not.toHaveBeenCalled()
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
