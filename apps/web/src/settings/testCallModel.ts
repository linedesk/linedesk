// The test call without React: how long it may take and what its failures say.

/** How long connecting, and then the assistant picking up, may take before the test call gives up. */
export const TEST_CALL_TIMEOUT_MS = 20_000

/** The server's refusal in words for the business; LiveKit and other internals stay out. */
export function testCallErrorText(error: string): string {
  if (/not set up|not configured/i.test(error))
    return "Test calls aren't set up on this server yet. Ask whoever runs your Linedesk."
  if (/too many test calls/i.test(error)) return 'Too many test calls in a short time. Try again in a few minutes.'
  // The daily limits (apps/api/src/test-call.ts) are written for people: shown as they are.
  if (/test calls today|as many test calls today|monthly spending cap/i.test(error)) return error
  return "The test call couldn't start. Try again in a moment."
}

export class TimedOut extends Error {}

/** Rejects with TimedOut after `ms`, so a hung connection ends with a clear message. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
