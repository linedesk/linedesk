import { expect, test } from 'vitest'
import { presenceOf } from './presence.ts'

test('green only when a number is connected and the voice stack is ready', () => {
  expect(presenceOf({ online: true, hasNumber: true, voiceReady: true })).toEqual({ kind: 'answering' })
  expect(presenceOf({ online: true, hasNumber: true, voiceReady: false })).toEqual({
    kind: 'notAnswering',
    reason: 'voice',
  })
  expect(presenceOf({ online: true, hasNumber: false, voiceReady: true })).toEqual({
    kind: 'notAnswering',
    reason: 'number',
  })
})

test('offline wins, and an unanswered check shows nothing rather than a guess', () => {
  expect(presenceOf({ online: false, hasNumber: true, voiceReady: true })).toEqual({ kind: 'offline' })
  expect(presenceOf({ online: true, hasNumber: true, voiceReady: null })).toEqual({ kind: 'unknown' })
  // Before the numbers arrive on a fresh device: not "no number connected".
  expect(presenceOf({ online: true, hasNumber: null, voiceReady: true })).toEqual({ kind: 'unknown' })
})

test('a lasting provider failure is not green either (LIN-111)', () => {
  expect(presenceOf({ online: true, hasNumber: true, voiceReady: true, voiceFailing: true })).toEqual({
    kind: 'notAnswering',
    reason: 'failing',
  })
  // Not set up says so first: nothing is failing that was never set up.
  expect(presenceOf({ online: true, hasNumber: true, voiceReady: false, voiceFailing: true })).toMatchObject({
    reason: 'voice',
  })
})
