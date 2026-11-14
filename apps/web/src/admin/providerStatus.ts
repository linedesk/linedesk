// Providers in one place (LIN-158): the status of every provider group in the web app, computed with the same
// statusGroups as the API (packages/actions/src/provider-status.ts) from the admin data: the stored tests
// (provider_tests), the recorded failures, how the assistants answer, and LiveKit from the health check. Admin ›
// Providers, the overview's "Ready for calls" card and the install walkthrough all read it from useProviderStatus, so
// "Works" means the same on every screen. A provider set up without a stored test is checked once with the free key
// check (provider.test with `free`: no tokens, no speech), never a paid round trip.
import {
  type GroupStatus,
  groupSpec,
  isMultiCategory,
  type ProviderFact,
  type ProviderLine,
  type ProviderName,
  type ProviderTestData,
  providerLine,
  providerNames,
  type StatusGroups,
  type StoredTest,
  statusGroups,
} from '@linedesk/actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { ADMIN_HEALTH, type AdminData, type AdminHealth, loadHealth, type ProviderStatus, testProvider } from './api.ts'
import { isConfigured } from './model.ts'
import { errorText } from './notify.ts'

/** Changes whenever the keys in effect change: a test of other keys no longer counts. */
export const keysSignature = (p: ProviderStatus) => JSON.stringify(p.fields.map(f => [f.source, f.last4, f.value]))

/** A test run on this page, for the keys it ran with. */
export type LocalTest = { keys: string; test: StoredTest | 'running' }
export type LocalTests = Partial<Record<ProviderName, LocalTest>>

type StatusData = Pick<AdminData, 'providers' | 'activeProviders' | 'tests' | 'providerFailures' | 'statusContext'>

/** When a provider's keys were last saved in the app (a failure from before is about the old keys). */
const keysAt = (p: ProviderStatus) =>
  p.fields
    .filter(f => f.source === 'app' && f.updated_at)
    .map(f => new Date(f.updated_at!).toISOString())
    .sort()
    .at(-1) ?? null

/** What is known about each provider: set up, in use, and its last test (one run here beats the stored one). */
export function providerFacts(data: StatusData, local: LocalTests = {}): ProviderFact[] {
  return providerNames.map(provider => {
    const p = data.providers.find(s => s.provider === provider)
    if (!p) return { provider, configured: false, active: false, test: null }
    const configured = isConfigured(p)
    const mine = local[provider]
    const test = mine && mine.keys === keysSignature(p) ? mine.test : (data.tests[provider] ?? null)
    return {
      provider,
      configured,
      active: isMultiCategory(p.category) ? configured : data.activeProviders[p.category]?.provider === provider,
      test: configured ? test : null,
      keysAt: keysAt(p),
    }
  })
}

/** LiveKit as the health check sees it; null while it is still being asked. */
export const callAudioOf = (health: AdminHealth | null | undefined) =>
  health?.livekit && health.sip
    ? { configured: health.livekitConfigured ?? true, server: health.livekit, sip: health.sip }
    : null

/** Every group's status, and each provider's own line. */
export function providerStatus(
  data: StatusData,
  local: LocalTests = {},
  health: AdminHealth | null = null,
): StatusGroups & { lines: Record<ProviderName, ProviderLine> } {
  const providers = providerFacts(data, local)
  const failures = data.providerFailures
  const status = statusGroups({ providers, failures, callAudio: callAudioOf(health), ...data.statusContext })
  const lines = Object.fromEntries(providers.map(f => [f.provider, providerLine(f, failures)])) as Record<
    ProviderName,
    ProviderLine
  >
  return { ...status, lines }
}

/** "tested 4 min ago", "tested just now", "tested Nov 13". */
/**
 * The line under a group's status: what is wrong while it fails or is half set up, otherwise why the group is there.
 * Embedded in the install walkthrough, the step's own lede already says why, so only a problem is shown there.
 */
export function groupNote(group: GroupStatus, embedded = false): string | null {
  if (group.message && group.state !== 'works' && group.state !== 'off') return group.message
  return embedded ? null : groupSpec(group.id).why
}

export function testedAgo(at: string | null, now = Date.now()): string | null {
  if (!at) return null
  const minutes = Math.round((now - new Date(at).getTime()) / 60_000)
  if (minutes < 1) return 'tested just now'
  if (minutes < 60) return `tested ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `tested ${hours} h ago`
  return `tested ${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/**
 * The status of every group from the admin data (null until it is there), with the free check of every provider that
 * is set up and has no stored result yet. `record` takes a test the dialog ran; `retest` runs the free check again.
 */
export function useProviderStatus(data: AdminData | null) {
  const health = useQuery(ADMIN_HEALTH, loadHealth).data ?? null
  const [local, setLocal] = useState<LocalTests>({})
  const asked = useRef(new Map<ProviderName, string>())

  const put = useCallback((p: ProviderStatus, test: LocalTest['test']) => {
    setLocal(t => ({ ...t, [p.provider]: { keys: keysSignature(p), test } }))
  }, [])
  const check = useCallback(
    async (p: ProviderStatus) => {
      put(p, 'running')
      const result: ProviderTestData = await testProvider(p.provider, { free: true }).catch(err => ({
        ok: false,
        message: errorText(err),
      }))
      put(p, { ok: result.ok, message: result.message, at: new Date().toISOString() })
      return result
    },
    [put],
  )

  // Set up, but never tested with these keys: the free check, once per set of keys.
  useEffect(() => {
    if (!data) return
    for (const p of data.providers) {
      if (!isConfigured(p) || data.tests[p.provider]) continue
      const keys = keysSignature(p)
      if (asked.current.get(p.provider) === keys) continue
      asked.current.set(p.provider, keys)
      void check(p)
    }
  }, [data, check])

  const find = (name: ProviderName) => data?.providers.find(p => p.provider === name)
  return {
    status: data ? providerStatus(data, local, health) : null,
    health,
    /** A test the dialog ran (Save, Test again, a round trip): shown at once. */
    record: (name: ProviderName, result: ProviderTestData) => {
      const p = find(name)
      if (p) put(p, { ok: result.ok, message: result.message, at: new Date().toISOString() })
    },
    /** The free check again (Test again). */
    retest: async (name: ProviderName) => {
      const p = find(name)
      return p ? check(p) : null
    },
  }
}
export type ProviderStatusState = ReturnType<typeof useProviderStatus>
