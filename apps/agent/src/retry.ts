// Retry with exponential backoff for writes that must not be lost (finishing a call).
import { ActionError } from './api-client.ts'

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  wait?: (ms: number) => Promise<unknown>
}

/** A rejection (4xx) is the API's final answer; only transport errors and 5xx are worth retrying. */
const isFinal = (e: unknown) => e instanceof ActionError && e.status < 500

export async function withRetry<T>(run: () => Promise<T>, { attempts = 5, baseDelayMs = 500, wait }: RetryOptions = {}): Promise<T> {
  const pause = wait ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (e) {
      if (attempt >= attempts || isFinal(e)) throw e
      await pause(baseDelayMs * 2 ** (attempt - 1))
    }
  }
}
