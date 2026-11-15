import { describe, expect, it } from 'vitest'
import { installPartsMissing } from './agent-setup-passkey.ts'

describe('the way by hand', () => {
  it('starts with the server parts while one is not set up', () => {
    const step = (id: string, state: string) => ({ id, state })
    expect(installPartsMissing([step('answering', 'done'), step('email', 'todo')])).toBe(true)
    expect(installPartsMissing([step('answering', 'done'), step('telephony', 'done'), step('workspace', 'todo')])).toBe(
      false,
    )
  })
})
