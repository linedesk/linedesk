// Test helpers: wait for a state instead of a fixed time, so tests hold on a slow machine.
const WAIT_MS = 3000

/** Resolves once `check` passes (it may throw an assertion error meanwhile); rethrows its last error after a while. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = WAIT_MS): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    try { await check(); return } catch (error) {
      if (Date.now() > until) throw error
      await new Promise(r => setTimeout(r, 10))
    }
  }
}

/** A short pause before asserting that something did NOT happen. */
export const quietFor = (ms = 60) => new Promise(r => setTimeout(r, ms))
