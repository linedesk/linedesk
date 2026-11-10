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
