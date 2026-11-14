import { describe, expect, it } from 'vitest'
import { installPartsMissing, passkeyStepOf, withPasskeyAdded } from './agent-setup-passkey.ts'

type Step = {
  id: string
  label: string
  group: 'you' | 'server' | 'business'
  state: 'done' | 'todo' | 'failing' | 'admin_only'
}
const stateWith = (steps: Step[]) => ({ progress: { steps, nextStep: null, allDone: false } })
const passkey = (state: Step['state']): Step => ({ id: 'passkey', label: 'Your passkey', group: 'you', state })
const answering: Step = { id: 'answering', label: 'AI', group: 'server', state: 'todo' }

describe('the passkey step on the agent setup page', () => {
  it('is to do while the admin has none (the setup lists it as theirs)', () => {
    expect(passkeyStepOf(stateWith([passkey('admin_only'), answering]), false)).toBe('todo')
  })

  it('is done once the setup says so, or at once when it was added here', () => {
    expect(passkeyStepOf(stateWith([passkey('done'), answering]), false)).toBe('done')
    expect(passkeyStepOf(stateWith([passkey('admin_only'), answering]), true)).toBe('done')
    expect(passkeyStepOf(null, true)).toBe('done')
  })

  it('is not known before the first read, and absent where admins need no passkey', () => {
    expect(passkeyStepOf(null, false)).toBe('loading')
    expect(passkeyStepOf(stateWith([answering]), false)).toBe('none')
  })

  it('the progress row flips to done when added here, nothing else changes', () => {
    const steps = [passkey('admin_only'), answering]
    expect(withPasskeyAdded(steps, false)).toEqual(steps)
    expect(withPasskeyAdded(steps, true)).toEqual([passkey('done'), answering])
  })
})

describe('the way by hand', () => {
  it('starts with the server parts while one is not set up', () => {
    const step = (id: string, state: string) => ({ id, state })
    expect(installPartsMissing([step('passkey', 'admin_only'), step('answering', 'done'), step('email', 'todo')])).toBe(
      true,
    )
    expect(installPartsMissing([step('answering', 'done'), step('telephony', 'done'), step('workspace', 'todo')])).toBe(
      false,
    )
  })
})
