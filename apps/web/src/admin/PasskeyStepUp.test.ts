import { expect, test, vi } from 'vitest'
import { stepUpLabel } from './api.ts'
import {
  answer,
  attachStepUpDialog,
  shownStepUp,
  StepUpRequired,
  stepUpOf,
  stepUpReason,
  withPasskeyStepUp,
} from './PasskeyStepUp.tsx'

test('only the step-up refusal asks for a passkey; enrol when the admin has none yet', () => {
  expect(stepUpOf({ code: 'PASSKEY_STEP_UP_REQUIRED', stepUp: 'confirm' })).toBe('confirm')
  expect(stepUpOf({ code: 'PASSKEY_STEP_UP_REQUIRED', stepUp: 'enrol' })).toBe('enrol')
  expect(stepUpOf({ code: 'SECOND_FACTOR_REQUIRED' })).toBeNull()
  expect(stepUpOf(null)).toBeNull()
})

test('other errors pass through; without the dialog mounted the refusal is not swallowed', async () => {
  const run = vi.fn().mockRejectedValue(new Error('the last instance admin cannot be revoked'))
  await expect(withPasskeyStepUp(run, 'x')).rejects.toThrow('last instance admin')
  const refused = vi.fn().mockRejectedValue(new StepUpRequired('Confirm with your passkey to do this.', 'confirm'))
  await expect(withPasskeyStepUp(refused, 'x')).rejects.toBeInstanceOf(StepUpRequired)
  expect(refused).toHaveBeenCalledTimes(1)
})

test('two step-ups at once: the dialog names each in turn; one passkey confirms both; cancel answers one; leaving cancels the rest', async () => {
  const detach = attachStepUpDialog(() => {})
  const refusedOnce = () => {
    let first = true
    return vi.fn(async () => {
      if (first) {
        first = false
        throw new StepUpRequired('Confirm with your passkey to do this.', 'confirm')
      }
      return 'done'
    })
  }
  const a = refusedOnce()
  const b = refusedOnce()
  const runA = withPasskeyStepUp(a, 'make an instance admin')
  const runB = withPasskeyStepUp(b, 'reset passkeys')
  await vi.waitFor(() => expect(shownStepUp()?.what).toBe('make an instance admin'))
  answer(true)
  await expect(runA).resolves.toBe('done')
  await expect(runB).resolves.toBe('done')
  expect(shownStepUp()).toBeUndefined()

  const c = withPasskeyStepUp(refusedOnce(), 'disable an admin')
  const d = withPasskeyStepUp(refusedOnce(), 'remove an admin from a workspace')
  await vi.waitFor(() => expect(shownStepUp()?.what).toBe('disable an admin'))
  answer(false)
  await expect(c).rejects.toBeInstanceOf(StepUpRequired)
  await vi.waitFor(() => expect(shownStepUp()?.what).toBe('remove an admin from a workspace'))
  detach()
  await expect(d).rejects.toBeInstanceOf(StepUpRequired)
})

test('the passkey dialog says what it confirms: a workspace to delete by its name (LIN-161)', () => {
  const what = stepUpLabel('workspace.delete', { workspaceId: 'ws_1', name: 'Riverside Electric' })
  expect(what).toBe('delete workspace Riverside Electric')
  expect(stepUpReason(what)).toMatch(/^Delete workspace Riverside Electric\. /)
  expect(stepUpLabel('instanceAdmin.grant')).toBe('make an instance admin')
})
