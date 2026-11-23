// Providers in one place (LIN-158): the status of every provider group in the web app, computed with the same
// statusGroups as the API (packages/actions/src/provider-status.ts) from the admin data: the stored tests
// (provider_tests), the recorded failures, how the assistants answer, and LiveKit from the health check. Server admin ›
// Providers, the overview's "Ready for calls" card and the install walkthrough all read it from useProviderStatus, so
// "Works" means the same on every screen. A provider set up without a stored test is checked once with the free key
// check (provider.test with `free`: no tokens, no speech), never a paid round trip.
import {
  callAudioGuide,
  callAudioStep,
  type GroupStatus,
  groupSpec,
  isMultiCategory,
  oauthClientRejectedBy,
  type ProviderFact,
  type ProviderFailureReason,
  type ProviderGroupId,
  type ProviderLine,
  type ProviderName,
  type ProviderTestData,
  providerErrorSummary,
  providerLine,
  providerNames,
  type StatusGroups,
  type StatusState,
  type StoredTest,
  statusGroups,
  statusText,
} from '@linedesk/actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { ADMIN_HEALTH, type AdminData, type AdminHealth, loadHealth, type ProviderStatus, testProvider } from './api.ts'
import { isConfigured } from './model.ts'
import { errorText } from './notify.ts'

/** Changes whenever the keys in effect change: a test of other keys no longer counts. */
export const keysSignature = (p: ProviderStatus) => JSON.stringify(p.fields.map(f => [f.source, f.last4, f.value]))

/** Changes whenever keys are stored, also the same keys again: when they were saved is part of it. */
export const storedSignature = (p: ProviderStatus) =>
  JSON.stringify(p.fields.map(f => [f.source, f.last4, f.value, f.updated_at]))

/** A test recorded right after its keys were stored, waiting for the admin data that has them. */
export type Awaited = { before: string; test: StoredTest }

/**
 * The awaited tests whose keys have arrived (the provider's stored keys changed since the test), taken out of
 * `awaiting`: from now on they count for those keys. The others keep waiting.
 */
export function settleAwaited(
  awaiting: Map<ProviderName, Awaited>,
  providers: readonly ProviderStatus[],
): [ProviderStatus, StoredTest][] {
  const settled: [ProviderStatus, StoredTest][] = []
  for (const [name, { before, test }] of awaiting) {
    const p = providers.find(s => s.provider === name)
    if (!p || storedSignature(p) === before) continue
    awaiting.delete(name)
    settled.push([p, test])
  }
  return settled
}

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
  const status = statusGroups({ providers, failures, callAudio: callAudioOf(health), ...data.statusContext }, i18n())
  const lines = Object.fromEntries(providers.map(f => [f.provider, providerLine(f, failures)])) as Record<
    ProviderName,
    ProviderLine
  >
  return { ...status, lines }
}

/**
 * The line under a group's heading, or null: only what everyone must read, i.e. what is wrong while the group fails
 * or is half set up. Why the group is there is help on demand (groupHelp), behind the (?) next to the heading.
 */
export function groupNote(group: GroupStatus): string | null {
  // A provider that fails says so on its own card (ProviderError): the error once, never again above it (LIN-249).
  if (group.state === 'failing' && group.parts.some(p => p.state === 'failing')) return null
  const problem = groupProblem(group)
  if (problem) return problem.line
  if (group.message && group.state !== 'works' && group.state !== 'off') return group.message
  // The development carrier works without a row of its own: the line says so, as no mark in the list can.
  if (group.id === 'telephony' && group.state === 'works' && !group.provider && group.message) return group.message
  return null
}

/**
 * Why a group is there, for the (?) next to its heading. Embedded in the install walkthrough, the step's own lede
 * already says it, so there is none there.
 */
export function groupHelp(group: Pick<GroupStatus, 'id'>, embedded = false): string | null {
  return embedded ? null : i18n().t(groupSpec(group.id).whyKey)
}

/**
 * The state a group's heading shows, or null: a group that is fine shows none (its providers carry the marks). Only a
 * problem gets the mark and its word: failing, partly working, or not set up while calls need it.
 */
export function groupAttention(group: Pick<GroupStatus, 'state' | 'needed'>): StatusState | null {
  if (group.state === 'failing' || group.state === 'partly') return group.state
  return group.state === 'missing' && group.needed ? 'missing' : null
}

/**
 * A provider row's status: a working provider shows only its check, the words are its tooltip and accessible label;
 * a state that needs attention (failing, partly, being tested, not tested) keeps its words next to the mark. `inUse`:
 * the one a choice picked; the row shows it as its own "In use" badge (next to the check), and it is in the tooltip.
 * `fromServer`: its keys come from the server's settings, said in the tooltip (the dialog shows it per field).
 */
export function rowStatus(
  line: Pick<ProviderLine, 'state' | 'detail'>,
  { inUse = false, fromServer = false }: { inUse?: boolean; fromServer?: boolean } = {},
): { label: string; words: string | null } {
  const { t } = i18n()
  const text = statusText(line, i18n())
  const label = [
    text,
    inUse ? t('admin.providers.row.inUse') : null,
    fromServer ? t('admin.providers.row.keysFromServer') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return { label, words: line.state === 'works' ? null : text }
}

/**
 * The muted value of a group's row on the overview: what is in use, compact ("OpenAI Realtime", "Deepgram · OpenAI ·
 * ElevenLabs"), while it works; the problem in words otherwise.
 */
/**
 * A group that fails or only partly works, said for people: a short sentence for the line under its name (it wraps,
 * never cut off), and the technical detail with the fix for the (?) beside it (help on demand). Call audio's server
 * texts are terse ("No inbound trunk, so no call can arrive (run setup-sip)"), so they become the detail; other
 * groups' messages are already sentences ("OpenAI rejected the key.").
 */
export function groupProblem(group: GroupStatus): { line: string; detail: string | null } | null {
  if (group.state !== 'failing' && group.state !== 'partly') return null
  const server = group.message?.replace(/\s*\(run setup-sip\)$/, '') ?? null
  if (group.id === 'call-audio' && group.state === 'partly') {
    return {
      line: i18n().t('admin.providerStatus.callAudio.noTrunk'),
      detail: [server && `${server}.`, callAudioStep(callAudioGuide.stepKeys[2], i18n())].filter(Boolean).join(' '),
    }
  }
  if (group.id === 'call-audio') {
    return { line: i18n().t('admin.providerStatus.callAudio.unreachable'), detail: server && `${server}.` }
  }
  // One short line (a provider's raw error never: providerErrorLine); the full text behind the (?).
  if (!group.message) return { line: statusText(group, i18n()), detail: null }
  const line = group.state === 'failing' ? providerErrorLine(group.message) : group.message
  return { line, detail: line === group.message.trim() ? null : group.message }
}

/** The provider behind a failing group, and why it fails: what the overview says in its own words, and its fix. */
export type GroupTrouble = { provider: ProviderName; label: string; reason: ProviderFailureReason }

export function groupTrouble(group: GroupStatus): GroupTrouble | null {
  if (group.state !== 'failing') return null
  const failing = group.parts.filter(p => p.state === 'failing' && p.label)
  // Answering calls lists every provider behind it; the one whose error the group shows is the one to name.
  const part = failing.find(p => p.message === group.message) ?? failing[0]
  return part ? { provider: part.provider, label: part.label, reason: part.reason ?? 'unknown' } : null
}

/** What stops working when a group fails, as the `effect` of admin.status.fix.line; the rest say the group's name. */
const EFFECTS: Partial<Record<ProviderGroupId, string>> = {
  answering: 'answering',
  email: 'email',
  telephony: 'telephony',
  'sign-in': 'signIn',
  calendar: 'calendar',
  recording: 'recording',
  transcript: 'transcript',
  billing: 'billing',
}

/** The row's line: the provider, what is wrong and what that stops ("OpenRouter rejects its API key, so calls can't be answered."). */
export const troubleLine = (group: Pick<GroupStatus, 'id' | 'label'>, trouble: GroupTrouble) =>
  i18n().t('admin.status.fix.line', {
    reason: trouble.reason,
    provider: trouble.label,
    effect: EFFECTS[group.id] ?? 'other',
    group: group.label,
  })

/** The card's top line: the provider and what is wrong ("OpenRouter's API key was rejected."). */
export const troubleHeadline = (trouble: GroupTrouble) =>
  i18n().t('admin.status.fix.headline', { reason: trouble.reason, provider: trouble.label })

/** The fix the row offers in place: a new key, while the provider rejects the one it has. */
export const replacesKey = (trouble: GroupTrouble | null) => trouble?.reason === 'auth'

/** The short line of a provider's error: a known reason in the reader's language, else providerErrorSummary. */
export function providerErrorLine(message: string): string {
  const rejectedBy = oauthClientRejectedBy(message)
  if (rejectedBy) return i18n().t('admin.providerError.oauthClientRejected', { provider: rejectedBy })
  return providerErrorSummary(message, i18n())
}

export function groupValue(group: GroupStatus): string | null {
  if (group.state !== 'works') return statusText(group, i18n())
  return group.answeredBy?.length ? group.answeredBy.join(' · ') : group.providerLabel
}

/** "tested 4 min ago", "tested just now", "tested Nov 13". */
export function testedAgo(at: string | null, now = Date.now()): string | null {
  if (!at) return null
  const { t } = i18n()
  const minutes = Math.round((now - new Date(at).getTime()) / 60_000)
  if (minutes < 1) return t('admin.providerStatus.tested.justNow')
  if (minutes < 60) return t('admin.providerStatus.tested.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('admin.providerStatus.tested.hours', { count: hours })
  return t('admin.providerStatus.tested.date', {
    date: fmt().dateTime(new Date(at), { month: 'short', day: 'numeric' }),
  })
}

/**
 * The status of every group from the admin data (null until it is there), with the free check of every provider that
 * is set up and has no stored result yet. `record` takes a test the dialog ran; `retest` runs the free check again.
 */
export function useProviderStatus(data: StatusData | null) {
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
      put(p, { ok: result.ok, message: result.message, at: new Date().toISOString(), reason: result.reason })
      return result
    },
    [put],
  )

  /**
   * Tests of keys the dialog has just stored, until the admin data with those keys arrives: the dialog records the test
   * before it reloads. Counted for the keys of the render before, the test was stale once the reload landed, and the
   * free check ran again ("Checking…") right after the dialog said "Connected" (LIN-364).
   */
  const awaiting = useRef(new Map<ProviderName, Awaited>())

  // Set up, but never tested with these keys: the free check, once per set of keys.
  useEffect(() => {
    if (!data) return
    for (const [p, test] of settleAwaited(awaiting.current, data.providers)) {
      asked.current.set(p.provider, keysSignature(p))
      put(p, test)
    }
    for (const p of data.providers) {
      if (!isConfigured(p) || data.tests[p.provider] || awaiting.current.has(p.provider)) continue
      const keys = keysSignature(p)
      if (asked.current.get(p.provider) === keys) continue
      asked.current.set(p.provider, keys)
      void check(p)
    }
  }, [data, put, check])

  const find = (name: ProviderName) => data?.providers.find(p => p.provider === name)
  return {
    status: data ? providerStatus(data, local, health) : null,
    health,
    /**
     * A test the dialog ran (Save, Test again, a round trip): shown at once. `stored`: the dialog has just saved the keys
     * and reloads next, so the test counts for the keys that reload brings.
     */
    record: (name: ProviderName, result: ProviderTestData, { stored = false }: { stored?: boolean } = {}) => {
      const p = find(name)
      if (!p) return
      const test = { ok: result.ok, message: result.message, at: new Date().toISOString(), reason: result.reason }
      if (stored) awaiting.current.set(name, { before: storedSignature(p), test })
      else put(p, test)
    },
    /** The free check again (Test again). */
    retest: async (name: ProviderName) => {
      const p = find(name)
      return p ? check(p) : null
    },
  }
}
export type ProviderStatusState = ReturnType<typeof useProviderStatus>
