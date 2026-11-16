// Every fixed text the agent files (no language model involved) is written in the team's language, like the generated
// summaries: production, 2026-11-15, a Spanish workspace got "The caller hung up without saying anything." in English.
import { expect, test, vi } from 'vitest'

// Each text says which language it was asked in, so the test sees the language that reached it.
vi.mock('./team-text.ts', () => ({
  teamT: (language: string | null | undefined) => (key: string, values?: Record<string, unknown>) =>
    `${language}:${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
}))

const { CallLog, finishCall } = await import('./call-log.ts')
const { hangupResult, mergeToolResults, summarizeCall, voiceFailedResult } = await import(
  './summary.ts'
)
const { missedResult } = await import('./not-ready.ts')
type CallSession = import('./call-session.ts').CallSession

const noWait = { wait: async () => {} }
const spanishCall = () =>
  ({
    callId: 'call_1',
    workspaceId: 'ws_1',
    contact: null,
    teamLanguage: 'es',
    append: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  }) as unknown as CallSession & { finish: ReturnType<typeof vi.fn> }

test('a caller who said nothing: title and summary in the team language, without asking the model', async () => {
  expect(hangupResult('es')).toEqual({
    outcome: 'hangup',
    urgency: 'low',
    title: 'es:call.autoSummary.hungUp.title',
    summary: 'es:call.autoSummary.hungUp.summary',
  })
  const complete = vi.fn(async () => '{}')
  expect(await summarizeCall([{ speaker: 'agent', text: 'Gracias por llamar.' }], complete, [], 'es')).toEqual(
    hangupResult('es'),
  )
  expect(complete).not.toHaveBeenCalled()
  // Through the call's end: the language is the call's (CallSession.teamLanguage).
  const call = spanishCall()
  const log = new CallLog(call)
  log.record('agent', 'Gracias por llamar.')
  await finishCall(call, log, complete, noWait)
  expect(call.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'es:call.autoSummary.hungUp.title',
      summary: 'es:call.autoSummary.hungUp.summary',
    }),
  )
})

test('the items the agent adds itself are in the team language', () => {
  const bare = {
    outcome: 'callback' as const,
    urgency: 'normal' as const,
    title: 'Fuga',
    summary: 'Elena tiene una fuga.',
    actionItems: [],
  }
  // Without a number: what the call was about, in the language of the summary.
  expect(mergeToolResults(bare, { messages: [], urgent: false }, false, 'es').actionItems).toEqual([
    { text: 'Elena tiene una fuga.' },
  ])
  expect(mergeToolResults(bare, { messages: [], urgent: false }, true, 'es').actionItems).toEqual([
    { text: 'es:call.autoSummary.callBack {"detail":"Elena tiene una fuga."}' },
  ])
  // A "call back" item from the model, without a number: only what it is about.
  const asked = { ...bare, actionItems: [{ text: 'Call the caller back: she has a leak' }] }
  expect(mergeToolResults(asked, { messages: [], urgent: false }, false, 'es').actionItems).toEqual([
    { text: 'She has a leak' },
  ])
  // Hung up during a collection step.
  const midStep = mergeToolResults(
    { ...bare, outcome: 'hangup' },
    { messages: [], urgent: false, collecting: 'callback number', confirmedName: 'Elena' },
    true,
    'es',
  )
  expect(midStep.actionItems![0]!.text).toMatch(
    /^es:call\.autoSummary\.callBackWho .*"who":"Elena".*es:call\.autoSummary\.endedMidStep/,
  )
})

test('voice failures and missed calls are filed in the team language', () => {
  expect(voiceFailedResult('tts', 'es')).toEqual({
    outcome: 'callback',
    urgency: 'normal',
    title: 'es:call.autoSummary.voiceFailed.title {"stage":"tts"}',
    summary: 'es:call.autoSummary.voiceFailed.summary {"stage":"tts"}',
    actionItems: [{ text: 'es:call.autoSummary.voiceFailed.item {"stage":"tts"}' }],
  })
  expect(missedResult('es')).toEqual({
    outcome: 'hangup',
    title: 'es:call.autoSummary.missed.title',
    summary: 'es:call.autoSummary.missed.notReady',
    actionItems: [{ text: 'es:call.autoSummary.missed.callBack' }],
  })
})
