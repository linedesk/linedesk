/** A quiet toast; with `undo`, it offers Undo (and Z) for a few seconds. */
export type Notify = (text: string, undo?: () => Promise<unknown>) => void

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
