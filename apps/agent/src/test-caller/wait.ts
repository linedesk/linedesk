// How the call test waits for the business's call to be finished (and, if expected, recorded).
import type { CallTestFinding } from '@linedesk/actions'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The agent links the recording after it finished the call (once egress has written the file, up to
 * RECORDING_WAIT_MS), so a completed call may not have it yet: wait this much longer for it.
 */
export const RECORDING_GRACE_MS = 30_000

/** Polls until the call is completed (and, if expected, has its recording) or the deadline passes. */
export async function waitForFinishedCall(
  find: () => Promise<CallTestFinding>, deadline: number, poll: () => Promise<void>,
  { expectRecording = false, graceMs = RECORDING_GRACE_MS, now = Date.now, wait = sleep } = {},
): Promise<CallTestFinding> {
  let finding = await find()
  let completedAt: number | null = null
  for (;;) {
    if (finding.call?.status === 'completed') {
      completedAt ??= now()
      if (!expectRecording || finding.call.recording_key || now() - completedAt >= graceMs) return finding
    }
    if (now() >= deadline) return finding
    await wait(3000)
    await poll()
    finding = await find()
  }
}
