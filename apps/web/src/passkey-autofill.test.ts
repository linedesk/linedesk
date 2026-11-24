import { describe, expect, it, vi } from 'vitest'
import { type AutofillDeps, passkeyAutofill } from './passkey-autofill.ts'

const OPTIONS = { challenge: 'c', rpId: 'example.test' } as never
const RESPONSE = { id: 'cred' } as never

/** A promise the test settles by hand. */
function later<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function deps(change: Partial<AutofillDeps> = {}): AutofillDeps {
  return {
    available: vi.fn(async () => true),
    challenge: vi.fn(async () => ({ data: OPTIONS, error: null })),
    pick: vi.fn(async () => RESPONSE),
    verify: vi.fn(async () => ({ data: { token: 't' }, error: null })),
    cancelCeremony: vi.fn(),
    ...change,
  }
}

describe("the browser's passkey suggestion in the email field", () => {
  it('signs in with a passkey picked in the field', async () => {
    const d = deps()
    await expect(passkeyAutofill(d).offer()).resolves.toBe(true)
    expect(d.verify).toHaveBeenCalledWith(RESPONSE)
  })

  it('asks for no challenge where the browser does not offer passkeys in autofill', async () => {
    const d = deps({ available: vi.fn(async () => false) })
    await expect(passkeyAutofill(d).offer()).resolves.toBe(false)
    expect(d.challenge).not.toHaveBeenCalled()
  })

  it('stopped while its challenge is on the way: the request is aborted and no ceremony starts', async () => {
    const pending = later<{ data: never; error: null }>()
    let signal: AbortSignal | undefined
    const d = deps({
      challenge: vi.fn(s => {
        signal = s
        return pending.promise
      }),
    })
    const autofill = passkeyAutofill(d)
    const offered = autofill.offer()
    await vi.waitFor(() => expect(d.challenge).toHaveBeenCalled())
    autofill.stop()
    expect(signal?.aborted).toBe(true)
    expect(d.cancelCeremony).toHaveBeenCalledTimes(1)
    pending.resolve({ data: OPTIONS, error: null }) // a late answer changes nothing
    await expect(offered).resolves.toBe(false)
    expect(d.pick).not.toHaveBeenCalled()
  })

  it('stopped while waiting for a pick: the ceremony is cancelled and nothing is verified', async () => {
    const picking = later<never>()
    const d = deps({
      pick: vi.fn(() => picking.promise),
      cancelCeremony: vi.fn(() => picking.reject(new Error('aborted'))),
    })
    const autofill = passkeyAutofill(d)
    const offered = autofill.offer()
    await vi.waitFor(() => expect(d.pick).toHaveBeenCalled())
    autofill.stop()
    await expect(offered).resolves.toBe(false)
    expect(d.verify).not.toHaveBeenCalled()
  })

  it('stop without a suggestion running cancels nothing (the button ceremony is left alone)', () => {
    const d = deps()
    passkeyAutofill(d).stop()
    expect(d.cancelCeremony).not.toHaveBeenCalled()
  })

  it('a refused challenge or verification is no sign-in, and nothing throws', async () => {
    await expect(
      passkeyAutofill(deps({ challenge: vi.fn(async () => ({ data: null, error: { status: 429 } })) })).offer(),
    ).resolves.toBe(false)
    await expect(
      passkeyAutofill(deps({ verify: vi.fn(async () => ({ data: null, error: { status: 401 } })) })).offer(),
    ).resolves.toBe(false)
    await expect(
      passkeyAutofill(deps({ available: vi.fn(async () => Promise.reject(new Error('x'))) })).offer(),
    ).resolves.toBe(false)
  })
})
