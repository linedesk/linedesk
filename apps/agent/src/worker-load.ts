// When the voice agent worker calls itself full, and the load it reports to LiveKit.
//
// The SDK's load is the CPU of the whole machine (or of the container's share), not of this worker's calls. On a busy
// host (a build, a small server with Postgres next to it) it passes 0.95 while the worker could answer easily. With one
// worker, "full" means no agent at all: LiveKit logs "no servers available" and the caller hears silence. So by default
// the worker never refuses a call because of load; a warning in the log shows the overload instead.
//
// AGENT_LOAD_THRESHOLD (0 to 1, e.g. 0.8) turns refusing on, for an install with more than one agent worker: a busy
// worker then reports itself full and LiveKit gives the call to another one. docker-compose.yml sets LiveKit's
// agents.target_load from the same variable, with the same default (DEFAULT_LOAD_THRESHOLD).

/** Default threshold: above the highest load the SDK reports (it clamps to 0..1), so the worker is never full. */
export const DEFAULT_LOAD_THRESHOLD = 1.01
/**
 * The highest load reported to LiveKit while the worker never refuses. LiveKit picks a worker weighted by 1 - load
 * (agenthandler.go, selectWorkerWeightedByLoad) and finds none with capacity at exactly 1.
 */
export const MAX_REPORTED_LOAD = 0.99
/** Above this load the log says the host is overloaded (calls are still answered unless refusing is turned on). */
export const LOAD_WARN_AT = 0.95
/** At most one overload warning this often. */
export const LOAD_WARN_EVERY_MS = 60_000
/**
 * After the worker starts it never refuses a call because of load for this long. A new worker loads its warm processes
 * at once (AGENT_IDLE_PROCESSES, about 2 s of CPU each), which puts its CPU over the threshold for a few seconds,
 * also with no call. During an update the old worker is draining at the same time, so a "full" new worker leaves a call
 * in those seconds without an assistant (production agent-1, 2026-11-22, LIN-795).
 */
export const START_GRACE_MS = 60_000
/** How far under the threshold the load is reported in the grace time. */
export const GRACE_MARGIN = 0.01

export type LoadPolicy = {
  /** The SDK's loadThreshold: at or above it the worker reports itself full. */
  threshold: number
  /** Whether the worker ever refuses a call because of load (AGENT_LOAD_THRESHOLD between 0 and 1). */
  refuses: boolean
  /** AGENT_LOAD_THRESHOLD was set to something that is not a number above 0: ignored. */
  ignored: string | null
}

/** The policy for AGENT_LOAD_THRESHOLD: unset (or 1 and above) never refuses; 0 < value < 1 refuses at that load. */
export function loadPolicy(raw: string | undefined): LoadPolicy {
  const text = raw?.trim() ?? ''
  const value = Number(text)
  if (text && Number.isFinite(value) && value > 0 && value < 1)
    return { threshold: value, refuses: true, ignored: null }
  const ignored = text && !(Number.isFinite(value) && value > 0) ? text : null
  return { threshold: DEFAULT_LOAD_THRESHOLD, refuses: false, ignored }
}

/** One line for the worker's start-up log. */
export function describeLoadPolicy(policy: LoadPolicy): string {
  const ignored = policy.ignored
    ? ` (AGENT_LOAD_THRESHOLD=${policy.ignored} is not a load between 0 and 1: ignored)`
    : ''
  return policy.refuses
    ? `Calls: this worker takes no new call at ${percent(policy.threshold)} CPU load or more (AGENT_LOAD_THRESHOLD); another worker takes it.`
    : `Calls: taken at any CPU load${ignored}. Set AGENT_LOAD_THRESHOLD only when more than one agent worker runs.`
}

const percent = (load: number) => `${Math.round(load * 100)}%`

/**
 * Wraps the SDK's load measure (ServerOptions.loadFunc, called every few seconds): warns at most once a minute while
 * the load is above LOAD_WARN_AT, and while the worker never refuses (by policy, or in its first graceMs after start)
 * caps what LiveKit sees at MAX_REPORTED_LOAD.
 */
export function reportedLoad<W>(
  measure: (worker: W) => Promise<number>,
  policy: LoadPolicy,
  warn: (line: string) => void,
  now: () => number = Date.now,
  graceMs: number = START_GRACE_MS,
): (worker: W) => Promise<number> {
  let lastWarning = Number.NEGATIVE_INFINITY
  const startedAt = now()
  return async worker => {
    const load = await measure(worker)
    const refuses = policy.refuses && now() - startedAt >= graceMs
    if (load > LOAD_WARN_AT && now() - lastWarning >= LOAD_WARN_EVERY_MS) {
      lastWarning = now()
      warn(
        refuses && load >= policy.threshold
          ? `Host CPU load is ${percent(load)}: this worker takes no new calls until it drops below ${percent(policy.threshold)} (AGENT_LOAD_THRESHOLD).`
          : `Host CPU load is ${percent(load)} (above ${percent(LOAD_WARN_AT)}). Calls are still answered, but replies may be slow: free up CPU or use a bigger server.`,
      )
    }
    if (refuses || !policy.refuses) return refuses ? load : Math.min(load, MAX_REPORTED_LOAD)
    // In the grace time after start: just under the worker's own threshold, which the SDK and LiveKit's target_load
    // compare with, so neither treats the new worker as full.
    return Math.min(load, policy.threshold - GRACE_MARGIN)
  }
}

/**
 * How long a call waited for a job process, from the SDK's timestamps (JobContext.info), for the call's setup log.
 * The SDK keeps AGENT_IDLE_PROCESSES processes warm and starts new ones one at a time, so in a burst of more calls than
 * that each further call waits for one more process to load (seconds on a busy voice core, LIN-465).
 */
export function describeProcessWait(info: {
  receivedAt?: number
  launchedAt?: number
  launchedWarm?: boolean
}): string | null {
  if (info.receivedAt === undefined || info.launchedAt === undefined) return null
  const waited = Math.max(0, Math.round(info.launchedAt - info.receivedAt))
  return info.launchedWarm ? `warm process after ${waited} ms` : `no warm process: waited ${waited} ms for a new one`
}
