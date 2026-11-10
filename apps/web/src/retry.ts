/** Waits for retries: 1 s, 2 s, 4 s … up to 30 s. */
export const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt)

/** Thrown when the server could not be reached at all (no network, a restart, a 5xx). */
export class Unreachable extends Error {
  constructor() { super("Can't reach the server.") }
}

/** fetch that turns "could not reach the server" into Unreachable, so callers can tell it from "signed out". */
export async function reach(input: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try { res = await fetch(input, init) } catch { throw new Unreachable() }
  if (res.status >= 500) throw new Unreachable()
  return res
}
