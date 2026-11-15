// Reads settings that are not in the local store (workspace_settings is not synced) through the
// registry's read-only actions. Changes go through the outbox with useRun, like every other write.
import type { ActionResult, WorkspaceSettingsData } from '@linedesk/actions'
import { useCallback } from 'react'
import { useStore } from '../store.tsx'
import { fetchQuery, refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { workspaceHeaders } from '../tabWorkspace.ts'

/** Runs a read-only registry action and returns its `data`. */
export async function readAction<T>(name: string, input: object = {}): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T } | null
  if (!res.ok || !body?.ok) throw new Error(i18n().t('settings.load.failed'))
  return body.data as T
}

/** Runs an action directly and returns its whole result; the rejection's text comes back as the error. */
async function runDirect(name: string, input: object): Promise<ActionResult> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  }).catch(() => null)
  const body = (await res?.json().catch(() => null)) as ActionResult | { ok: false; error?: string } | null
  if (!res?.ok || !body?.ok)
    throw new Error((body && !body.ok && body.error) || i18n().t('errors.unreachable'))
  return body
}

/**
 * Runs an action directly, not through the outbox, for the few that need the server's answer at once
 * (the calendar consent URL, the calendars of an account, a test send). Use useWriteAction for
 * actions that write synced rows.
 */
export async function callAction<T>(name: string, input: object = {}): Promise<T> {
  return (await runDirect(name, input)).data as T
}

/**
 * Like callAction, for actions that write synced rows: the rows it wrote and deleted show in the
 * local store at once, not at the next read sync.
 */
export function useWriteAction() {
  const store = useStore()
  return useCallback(
    async <T>(name: string, input: object = {}): Promise<T> => {
      const result = await runDirect(name, input)
      store.applyResult(result)
      return result.data as T
    },
    [store],
  )
}

const WORKSPACE_SETTINGS = 'workspace.settings'
const loadWorkspaceSettings = () => readAction<WorkspaceSettingsData>('workspace.getSettings')

/** The workspace's settings (hours, recordings): the last known at once, checked again in the background. */
export const useWorkspaceSettings = () => useQuery(WORKSPACE_SETTINGS, loadWorkspaceSettings, { persist: true })

/** Reads the settings again: after a change whose result the page could not tell itself. */
export const refreshWorkspaceSettings = () => refreshQuery(WORKSPACE_SETTINGS)

/** Loads the settings ahead, at app start, so Settings and Assistant open with them. */
export const preloadWorkspaceSettings = () => fetchQuery(WORKSPACE_SETTINGS, loadWorkspaceSettings, { persist: true })

/** After a change the page sent through the outbox: show it at once, like the local store does. */
export const patchWorkspaceSettings = (change: Partial<WorkspaceSettingsData>) =>
  setQueryData<WorkspaceSettingsData | undefined>(WORKSPACE_SETTINGS, s => (s ? { ...s, ...change } : s), {
    persist: true,
  })
