// Better Auth takes one `databaseHooks` object; several modules hook the same model and step
// (instance admins, account linking, the audit log). This runs them all, in the order given.

// biome-ignore lint/suspicious/noExplicitAny: Better Auth's hook signatures differ per model
type Hook = (data: any, ctx?: any) => Promise<unknown> | unknown
type Steps = Partial<Record<'before' | 'after', Hook>>
type HookSet = Partial<Record<string, Partial<Record<string, Steps>>>>

/** A `before` hook may return `{ data }` (the next one sees it) or `false` (stop); `after` hooks just run. */
function chain(step: 'before' | 'after', hooks: Hook[]): Hook {
  if (step === 'after') {
    return async (data, ctx) => {
      for (const hook of hooks) await hook(data, ctx)
    }
  }
  return async (data, ctx) => {
    let current = data
    let changed = false
    for (const hook of hooks) {
      const result = (await hook(current, ctx)) as { data?: unknown } | false | undefined
      if (result === false) return false
      if (result && typeof result === 'object' && 'data' in result) {
        // As Better Auth does with one hook: the returned fields are merged into the data.
        current = { ...(current as object), ...(result.data as object) }
        changed = true
      }
    }
    return changed ? { data: current } : undefined
  }
}

export function mergeDatabaseHooks(...sets: HookSet[]): HookSet {
  const collected: Record<string, Record<string, Record<'before' | 'after', Hook[]>>> = {}
  for (const set of sets)
    for (const [model, ops] of Object.entries(set))
      for (const [op, steps] of Object.entries(ops ?? {}))
        for (const step of ['before', 'after'] as const) {
          const hook = steps?.[step]
          if (!hook) continue
          collected[model] ??= {}
          collected[model][op] ??= { before: [], after: [] }
          collected[model][op][step].push(hook)
        }
  return Object.fromEntries(
    Object.entries(collected).map(([model, ops]) => [
      model,
      Object.fromEntries(
        Object.entries(ops).map(([op, steps]) => [
          op,
          {
            ...(steps.before.length ? { before: chain('before', steps.before) } : {}),
            ...(steps.after.length ? { after: chain('after', steps.after) } : {}),
          },
        ]),
      ),
    ]),
  )
}
