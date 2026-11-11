// Reads settings that are not in the local store (workspace_settings is not synced) through the
// registry's read-only actions. Changes go through the outbox with useRun, like every other write.

/** Runs a read-only registry action and returns its `data`. */
export async function readAction<T>(name: string, input: object = {}): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T } | null
  if (!res.ok || !body?.ok) throw new Error('These settings could not be loaded. Check the connection and try again.')
  return body.data as T
}

/**
 * Runs an action directly, not through the outbox, for the few that need the server's answer at once
 * (the calendar consent URL, the calendars of an account). The rejection's text comes back as the error.
 */
export async function callAction<T>(name: string, input: object = {}): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  }).catch(() => null)
  const body = (await res?.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null
  if (!res?.ok || !body?.ok) throw new Error(body?.error ?? 'No connection to the server. Try again.')
  return body.data as T
}
