// The tools of a simulated call (LIN-391): the real definitions the worker gives the model (assistantTools, built with
// light fakes for the LiveKit and API pieces), sent as OpenAI function schemas the way LiveKit's OpenAI plugin sends
// them, so a new or changed tool description is tested without touching this suite. When the model calls one:
// - find_slots, book_appointment, cancel_appointment, reschedule_appointment, lookup_* and flag_urgent run their real
//   code against a fake API that answers what the case says (free times, a lookup answer, a failure);
// - collection steps (get_name, ...) and transfer_call, which talk to the caller themselves or dial out, return what
//   the real step returns for the outcome the case picks (describeOutcome, notConnectedReply);
// - end_call is played by the conversation engine (conversation.ts), with the worker's real closing flow.
import {
  type BookData,
  type CallAskWebhookData,
  type FindSlotsData,
  appointmentBook,
  appointmentCancel,
  appointmentReschedule,
  calendarFindSlots,
  callAskWebhook,
} from '@linedesk/actions'
import { llm } from '@livekit/agents'
import type { z } from 'zod'
import { ActionError, type ApiClient } from '../api-client.ts'
import { assistantTools, type Transfer } from '../assistant-tools.ts'
import type { CallLog } from '../call-log.ts'
import type { CallSession } from '../call-session.ts'
import type { CollectContext } from '../collect/collect-tools.ts'
import { describeOutcome, type CollectOutcome } from '../collect/collection.ts'
import { callerIdOf } from '../callback-number.ts'
import type { Setup } from './setups.ts'

/** A tool as the chat completions API takes it. */
export type OpenAiTool = {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
export type Tools = Record<string, llm.AnonFunctionTool<any, any, any>>

/** What the fake world answers; every field has a default (simDefaults). */
export type SimOptions = {
  /** Free times find_slots finds, as ISO starts; [] for none; 'fail' when the calendar cannot be reached. */
  slots?: string[] | 'fail'
  /** Whether book_appointment goes through. */
  bookFails?: boolean
  /** What cancel_appointment and reschedule_appointment find: the booking, or no match. */
  changeMatches?: boolean
  /** What lookup_* answers: an answer text, or 'fail' (the business's system cannot be reached). */
  lookup?: string | 'fail'
  /** How each collection step ends; default: confirmed with the demo caller's details. */
  steps?: Partial<Record<CollectTool, StepOutcome>>
  /** Whether the person picks up when the assistant puts the caller through. */
  transfer?: 'connected' | 'not_connected'
}

export type CollectTool = 'get_name' | 'get_phone_number' | 'get_address' | 'get_email'
export const COLLECT_TOOLS: readonly CollectTool[] = ['get_name', 'get_phone_number', 'get_address', 'get_email']
export const isCollectTool = (name: string): name is CollectTool => (COLLECT_TOOLS as readonly string[]).includes(name)

/** A step's end, as the caller would bring it about. */
export type StepOutcome =
  | { status: 'confirmed'; value: string }
  | { status: 'declined'; reason: string }
  | { status: 'incomplete'; partial?: string }
  | { status: 'question'; question: string }

const STEP_LABEL: Record<CollectTool, string> = {
  get_name: 'name',
  get_phone_number: 'callback number',
  get_address: 'address',
  get_email: 'email address',
}

export const DEMO_DETAILS: Record<CollectTool, string> = {
  get_name: 'Dana Ruiz',
  get_phone_number: '+1 503 555 0177',
  get_address: '4512 NE Fremont St, Portland, OR 97213',
  get_email: 'dana.ruiz@example.com',
}

/** What a collection step returns to the assistant for an outcome (the real describeOutcome). */
export function stepResult(
  tool: CollectTool,
  outcome: StepOutcome | undefined,
  setup: Setup,
): { result: string; value: string | null } {
  const label = tool === 'get_phone_number' ? 'callback number' : STEP_LABEL[tool]
  const o = outcome ?? { status: 'confirmed', value: DEMO_DETAILS[tool] }
  const full: CollectOutcome =
    o.status === 'confirmed'
      ? { status: 'confirmed', label, value: o.value }
      : o.status === 'declined'
        ? { status: 'declined', label, reason: o.reason }
        : o.status === 'incomplete'
          ? { status: 'incomplete', label, partial: o.partial ?? null }
          : { status: 'question', label, question: o.question, partial: null }
  const callerId = setup.caller?.phone ?? null
  return {
    result: describeOutcome(full, { callerId, testCall: setup.caller?.testCall === true }),
    value: o.status === 'confirmed' ? o.value : null,
  }
}

/** Default free times: the next three weekdays after `now`, at 9 AM and 1 PM Portland time (PST). */
export function defaultSlots(now: number): string[] {
  const out: string[] = []
  // Today in Portland, as a UTC date (PST is UTC-8 all of November).
  const local = new Date(now - 8 * 3600_000)
  for (let i = 1; out.length < 6 && i < 10; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i))
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue
    for (const hour of [9, 13]) out.push(new Date(day.getTime() + (hour + 8) * 3600_000).toISOString())
  }
  return out
}

/** "Tuesday, November 17 at 9:00 AM", as the API labels a time (apps/api bookings.ts slotLabel). */
export function slotLabel(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(iso))
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${part('weekday')}, ${part('month')} ${part('day')} at ${part('hour')}:${part('minute')} ${part('dayPeriod')}`
}

/** The API as far as the booking and lookup tools use it, answering from the case's SimOptions. */
function fakeApi(setup: Setup, sim: SimOptions): ApiClient {
  const run = async (action: { name: string }, input: Record<string, unknown>) => {
    if (action === calendarFindSlots) {
      if (sim.slots === 'fail') throw new ActionError(action.name, 502, 'the calendar did not answer')
      const from = typeof input.fromDate === 'string' ? input.fromDate : null
      const to = typeof input.toDate === 'string' ? input.toDate : null
      const local = (iso: string) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: setup.timeZone }).format(new Date(iso))
      const starts = (sim.slots ?? defaultSlots(setup.now)).filter(
        s => (!from || local(s) >= from) && (!to || local(s) <= to),
      )
      const data: FindSlotsData = {
        appointmentTypeId: String(input.appointmentTypeId),
        timeZone: setup.timeZone,
        slots: starts.map(start => ({
          start,
          end: new Date(Date.parse(start) + 3600_000).toISOString(),
          label: slotLabel(start, setup.timeZone),
        })),
      }
      return { data }
    }
    if (action === appointmentBook) {
      if (sim.bookFails) throw new ActionError(action.name, 409, 'that time is no longer free')
      const start = String(input.start)
      const data: BookData = {
        bookingId: 'bk_llm_test',
        start,
        end: start,
        label: slotLabel(start, setup.timeZone),
        calendarName: 'Service calendar',
      }
      return { data }
    }
    if (action === appointmentCancel || action === appointmentReschedule) {
      return {
        data:
          sim.changeMatches === false
            ? { changed: false, refused: 'no booking matches' }
            : { changed: true, label: 'Thursday, November 19 at 9:00 AM' },
      }
    }
    if (action === callAskWebhook) {
      const lookup = setup.lookups.find(l => l.name === input.lookup)
      const values = (input.values ?? {}) as Record<string, unknown>
      const missing = (lookup?.fields ?? [])
        .filter(f => f.required && (values[f.name] === undefined || values[f.name] === ''))
        .map(f => f.name)
      const data: CallAskWebhookData = missing.length
        ? { answer: null, problem: 'missing', missing }
        : sim.lookup === 'fail'
          ? { answer: null, problem: 'failed' }
          : {
              answer: sim.lookup ?? 'Job BW-1234: the technician is on the way and arrives between 2 and 4 PM today.',
              problem: null,
            }
      return { data }
    }
    // Recording the transfer, the urgent flag, ...: the fake API takes it.
    return { data: {} }
  }
  return { run } as unknown as ApiClient
}

/** What the tools record on the call; only what they read back matters here. */
export type FakeLog = { confirmedName: string | null; confirmedAddress: string | null; bookings: string[]; record: () => void }

/** A tool's options as LiveKit passes them, with nothing behind them: the tools only pause interruptions and nudge. */
export function fakeToolOptions(id: string): llm.ToolOptions {
  const session = { agentState: 'speaking', userState: 'listening', generateReply() {} }
  return {
    toolCallId: id,
    ctx: { disallowInterruptions() {}, session, speechHandle: {} },
    abortSignal: new AbortController().signal,
  } as unknown as llm.ToolOptions
}

export type SimTools = {
  tools: Tools
  log: FakeLog
  urgent: { flagged: boolean }
}

/** The real tools of a call with this setup (assistantTools in assistant-tools.ts). */
export function buildTools(setup: Setup, sim: SimOptions = {}): SimTools {
  const log: FakeLog = { confirmedName: null, confirmedAddress: null, bookings: [], record() {} }
  const urgent = { flagged: false }
  const call = {
    callId: 'call_llm_test',
    workspaceId: setup.assistant.workspace_id,
    assistant: setup.assistant,
    booking: setup.booking,
    lookups: setup.lookups,
    caller: setup.caller,
    contact: setup.caller?.phone ? { name: setup.caller.name, phone: setup.caller.phone } : null,
  } as unknown as CallSession
  const collect = {
    log,
    today: () => setup.booking?.todayDate ?? '2026-11-17',
    callerId: callerIdOf(call),
    testCall: setup.caller?.testCall === true,
  } as unknown as CollectContext
  const transfer = (setup.transfers.length ? { contacts: setup.transfers } : null) as Transfer
  const tools = assistantTools(
    fakeApi(setup, sim),
    call,
    log as unknown as CallLog,
    () => 'end_call is played by the conversation engine',
    async () => {
      urgent.flagged = true
    },
    transfer,
    collect,
    () => {},
  ) as Tools
  return { tools, log, urgent }
}

/** The tools as LiveKit's OpenAI plugin sends them: sorted by name, the zod parameters as JSON schema, not strict. */
export function openAiTools(tools: Tools): OpenAiTool[] {
  return Object.entries(tools)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tool]) => {
      const { $schema: _dropped, ...parameters } = llm.toJsonSchema(tool.parameters, true, false) as Record<
        string,
        unknown
      >
      return { type: 'function', function: { name, description: tool.description, parameters } }
    })
}

/** The arguments as LiveKit reads them: JSON (LiveKit also repairs broken JSON; this does not), checked against the tool's zod schema. */
export function parseArgs(
  tool: Tools[string],
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let args: unknown
  try {
    args = JSON.parse(raw || '{}')
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = (tool.parameters as z.ZodType).safeParse(args)
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.message}` }
  return { ok: true, args: parsed.data as Record<string, unknown> }
}
