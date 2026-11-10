import { expect, test } from 'vitest'
import { recordingOn } from './workspace-settings.ts'

test('calls are recorded only with a recording store, the same switch the voice agent reads', () => {
  expect(recordingOn({ RECORDING_STORE: 'file' })).toBe(true)
  expect(recordingOn({ RECORDING_STORE: 's3' })).toBe(true)
  expect(recordingOn({})).toBe(false)
  expect(recordingOn({ RECORDING_STORE: '' })).toBe(false)
  expect(recordingOn({ RECORDING_STORE: 'off' })).toBe(false)
})
