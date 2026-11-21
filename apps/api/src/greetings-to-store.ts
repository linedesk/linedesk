// The greetings the voice agent stores before the first call (LIN-679): for every assistant a phone number answers
// with, what call.start would send for it now (openCall: the assistant as the call's level answers, the workspace's
// language, the assistant's recording notice and hours). The agent builds each greeting text from it as a call would, and stores the
// ones it does not have yet, so no call of a burst waits for a voice made live (LIN-512).
import { recordingNoticeOf } from '@linedesk/actions'
import { organization, phone_numbers, type Tx } from '@linedesk/db'
import { asc, eq, isNull } from 'drizzle-orm'
import { assistantForNumber } from './assistants.ts'
import { businessHoursFor } from './handlers.ts'
import { keepsRecordings } from './recording-retention.ts'
import { assistantForCall } from './usage-levels.ts'
import { workspaceLocale } from './workspace-locale.ts'

/** Only what the agent needs to build and voice a greeting (review of LIN-679: not the assistant's instructions). */
const GREETING_FIELDS = [
  'id',
  'workspace_id',
  'greeting',
  'greeting_outside',
  'voice',
  'languages',
  'call_quality',
  'talking_speed',
  'talking_speed_pct',
  'record_calls',
] as const

export async function greetingsToStore(tx: Tx, now: string) {
  // Numbers of workspaces that take calls: openCall refuses a disabled one.
  const numbers = await tx
    .select({ workspace_id: phone_numbers.workspace_id, assistant_id: phone_numbers.assistant_id })
    .from(phone_numbers)
    .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
    .where(isNull(organization.disabledAt))
    .orderBy(asc(phone_numbers.workspace_id))
  const seen = new Set<string>()
  const out = []
  for (const number of numbers) {
    const assistant = await assistantForNumber(tx, number.workspace_id, number.assistant_id)
    if (!assistant || seen.has(assistant.id)) continue
    seen.add(assistant.id)
    // No ALERT lines from here: this runs every minute, a call logs its own fallback.
    const forCall = await assistantForCall(tx, number.workspace_id, assistant, () => {})
    if (forCall.level === 'not_allowed') continue
    const answering = forCall.assistant
    out.push({
      assistant: Object.fromEntries(GREETING_FIELDS.map(field => [field, answering[field]])),
      workspaceLanguage: (await workspaceLocale(tx, number.workspace_id)).resolvedLanguage,
      recordingNotice: recordingNoticeOf(assistant),
      keepRecording: await keepsRecordings(tx, number.workspace_id),
      businessHours: await businessHoursFor(tx, number.workspace_id, now),
    })
  }
  return out
}

/** How long the API answers the agents from its last list: every voice server asks every minute. */
export const GREETINGS_CACHE_MS = 30_000
