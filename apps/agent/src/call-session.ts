// One call as the agent sees it: start, append transcript segments, finish.
import { type BookingContext, callAppendTranscript, callFinish, callStart, callStartTest } from '@linedesk/actions'
import type { Assistant, Contact, ToolEvent } from '@linedesk/db/types'
import type { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import { forHours } from './prompt.ts'

export type Speaker = z.input<typeof callAppendTranscript.input>['speaker']
export type CallResult = Omit<z.input<typeof callFinish.input>, 'callId'>

/** The business's hours as `call.start` reports them: `summary` is a ready sentence for the assistant. */
export type BusinessHours = { openNow: boolean; summary: string }

export interface CallSession {
  callId: string
  workspaceId: string
  assistant: Assistant | null
  contact: Contact
  /** The caller's number is blocked: the API filed the call in Spam; hang up without answering. */
  blocked: boolean
  /** null: the business has no hours set, and the assistant says nothing about them. */
  businessHours: BusinessHours | null
  /** What the assistant can book; null: no appointment type or no calendar, so it only takes messages. */
  booking: BookingContext | null
  append(speaker: Speaker, text: string, toolEvent?: ToolEvent): Promise<void>
  finish(result: CallResult): Promise<void>
}

type StartData = Pick<CallSession, 'callId' | 'workspaceId' | 'assistant' | 'contact'> & { blocked?: boolean; businessHours?: BusinessHours | null; booking?: BookingContext | null }

/**
 * Where a call comes from. A test call may bring `businessHours` to use instead of the workspace's
 * (the call test sets "closed" for its after-hours scenario without touching the real settings).
 */
export type CallOrigin =
  | { kind: 'phone'; from: string; to: string; room?: string }
  | { kind: 'test'; workspaceId: string; room: string; assistantId?: string; businessHours?: BusinessHours; outsideGreeting?: string }

export async function startCall(api: ApiClient, origin: CallOrigin): Promise<CallSession> {
  const { data } = origin.kind === 'phone'
    ? await api.run(callStart, { from: origin.from, to: origin.to, room: origin.room })
    : await api.run(callStartTest, { room: origin.room, ...(origin.assistantId ? { assistantId: origin.assistantId } : {}) }, origin.workspaceId)
  const started = data as StartData
  const { callId, workspaceId, contact, blocked = false } = started
  const businessHours = (origin.kind === 'test' && origin.businessHours) || started.businessHours || null
  // The call test may set an outside greeting to check without touching the real assistant.
  const outsideGreeting = origin.kind === 'test' ? origin.outsideGreeting : undefined
  const configured = started.assistant && outsideGreeting ? { ...started.assistant, greeting_outside: outsideGreeting } : started.assistant
  // The greeting and instructions that apply now: outside business hours, the outside variants.
  const assistant = forHours(configured, businessHours)
  const booking = started.booking ?? null
  const startedAt = Date.now()
  return {
    callId, workspaceId, assistant, contact, blocked, businessHours, booking,
    async append(speaker, text, toolEvent) {
      await api.run(callAppendTranscript, { callId, speaker, text, atMs: Date.now() - startedAt, toolEvent }, workspaceId)
    },
    async finish(result) {
      await api.run(callFinish, { callId, ...result }, workspaceId)
    },
  }
}

/**
 * Where the call comes from. A test room from the web app carries `{ source: 'test', workspaceId, assistantId? }`
 * in the job metadata the API signed into the browser's token; anything else is a phone call, with
 * caller and dialled number in the attributes LiveKit SIP sets (the talk page sets the same ones).
 */
export function callOrigin(jobMetadata: string, attributes: Record<string, string>, room: string): CallOrigin {
  const test = parseTestMetadata(jobMetadata)
  if (test)
    return {
      kind: 'test',
      workspaceId: test.workspaceId,
      room,
      ...(test.assistantId ? { assistantId: test.assistantId } : {}),
      ...(test.businessHours ? { businessHours: test.businessHours } : {}),
      ...(test.outsideGreeting ? { outsideGreeting: test.outsideGreeting } : {}),
    }
  const from = attributes['sip.phoneNumber']
  const to = attributes['sip.trunkPhoneNumber']
  if (!from || !to) throw new Error('participant has no sip.phoneNumber / sip.trunkPhoneNumber attributes')
  return { kind: 'phone', from, to, room }
}

/** The workspace (and the assistant picked in the web app) of a test room the API signed, or null for any other room. */
export function parseTestMetadata(
  metadata: string,
): { workspaceId: string; assistantId?: string; businessHours?: BusinessHours; outsideGreeting?: string } | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; workspaceId?: unknown; assistantId?: unknown; businessHours?: unknown; outsideGreeting?: unknown }
    if (parsed.source !== 'test' || typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    const hours = parsed.businessHours as Partial<BusinessHours> | undefined
    const businessHours = hours && typeof hours.openNow === 'boolean' && typeof hours.summary === 'string' ? { openNow: hours.openNow, summary: hours.summary } : undefined
    const assistantId = typeof parsed.assistantId === 'string' && parsed.assistantId ? parsed.assistantId : undefined
    const outsideGreeting = typeof parsed.outsideGreeting === 'string' && parsed.outsideGreeting ? parsed.outsideGreeting : undefined
    return {
      workspaceId: parsed.workspaceId,
      ...(assistantId ? { assistantId } : {}),
      ...(businessHours ? { businessHours } : {}),
      ...(outsideGreeting ? { outsideGreeting } : {}),
    }
  } catch {
    return null
  }
}
