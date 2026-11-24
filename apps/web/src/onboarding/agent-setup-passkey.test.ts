import { installParts } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import { installPartsMissing } from './agent-setup-passkey.ts'

const step = (id: string, state: string) => ({ id, state })
const progress = { skipped: [], setAsideAt: null, finishedAt: null }

describe('the way by hand', () => {
  it('starts with the server parts while one is not set up', () => {
    expect(installPartsMissing([step('answering', 'done'), step('email', 'todo')])).toBe(true)
    expect(installPartsMissing([step('answering', 'done'), step('telephony', 'done'), step('business', 'todo')])).toBe(
      false,
    )
  })

  it('counts a part as handled once the walkthrough skipped it', () => {
    const steps = [step('email', 'todo'), step('answering', 'done'), step('call-audio', 'failing')]
    expect(installPartsMissing(steps, { ...progress, skipped: ['email'] })).toBe(true)
    expect(installPartsMissing(steps, { ...progress, skipped: ['email', 'call-audio'] })).toBe(false)
  })

  it('goes on to the business once the walkthrough was finished or set aside, never to its Done again', () => {
    const steps = [step('email', 'todo'), step('answering', 'todo')]
    expect(installPartsMissing(steps, progress)).toBe(true)
    expect(installPartsMissing(steps, { ...progress, finishedAt: '2026-11-18T10:00:00Z' })).toBe(false)
    expect(installPartsMissing(steps, { ...progress, setAsideAt: '2026-11-18T10:00:00Z' })).toBe(false)
  })

  it('names the server parts in one order everywhere', () => {
    expect(installParts).toEqual(['email', 'answering', 'telephony', 'call-audio'])
  })
})
