// One call as the agent sees it: start, append transcript segments, finish.
import { callAppendTranscript, callFinish, callStart, callStartTest } from '@linedesk/actions'
import type { Assistant, Contact, ToolEvent } from '@linedesk/db/types'
import type { z } from 'zod'
import type { ApiClient } from './api-client.ts'

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
  append(speaker: Speaker, text: string, toolEvent?: ToolEvent): Promise<void>
  finish(result: CallResult): Promise<void>
}

type StartData = Pick<CallSession, 'callId' | 'workspaceId' | 'assistant' | 'contact'> & { blocked?: boolean; businessHours?: BusinessHours | null }

/**
 * Where a call comes from. A test call may bring `businessHours` to use instead of the workspace's
 * (the call test sets "closed" for its after-hours scenario without touching the real settings).
 */
export type CallOrigin =
  | { kind: 'phone'; from: string; to: string; room?: string }
  | { kind: 'test'; workspaceId: string; room: string; businessHours?: BusinessHours }

export async function startCall(api: ApiClient, origin: CallOrigin): Promise<CallSession> {
  const { data } = origin.kind === 'phone'
    ? await api.run(callStart, { from: origin.from, to: origin.to, room: origin.room })
    : await api.run(callStartTest, { room: origin.room }, origin.workspaceId)
  const started = data as StartData
  const { callId, workspaceId, assistant, contact, blocked = false } = started
  const businessHours = (origin.kind === 'test' && origin.businessHours) || started.businessHours || null
  const startedAt = Date.now()
  return {
    callId, workspaceId, assistant, contact, blocked, businessHours,
    async append(speaker, text, toolEvent) {
      await api.run(callAppendTranscript, { callId, speaker, text, atMs: Date.now() - startedAt, toolEvent }, workspaceId)
    },
    async finish(result) {
      await api.run(callFinish, { callId, ...result }, workspaceId)
    },
  }
}

/**
 * Where the call comes from. A test room from the web app carries `{ source: 'test', workspaceId }`
 * in the job metadata the API signed into the browser's token; anything else is a phone call, with
 * caller and dialled number in the attributes LiveKit SIP sets (the talk page sets the same ones).
 */
export function callOrigin(jobMetadata: string, attributes: Record<string, string>, room: string): CallOrigin {
  const test = parseTestMetadata(jobMetadata)
  if (test) return { kind: 'test', workspaceId: test.workspaceId, room, ...(test.businessHours ? { businessHours: test.businessHours } : {}) }
  const from = attributes['sip.phoneNumber']
  const to = attributes['sip.trunkPhoneNumber']
  if (!from || !to) throw new Error('participant has no sip.phoneNumber / sip.trunkPhoneNumber attributes')
  return { kind: 'phone', from, to, room }
}

/** The workspace of a test room the API signed, or null for any other room. */
export function parseTestMetadata(metadata: string): { workspaceId: string; businessHours?: BusinessHours } | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; workspaceId?: unknown; businessHours?: unknown }
    if (parsed.source !== 'test' || typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    const hours = parsed.businessHours as Partial<BusinessHours> | undefined
    const businessHours = hours && typeof hours.openNow === 'boolean' && typeof hours.summary === 'string' ? { openNow: hours.openNow, summary: hours.summary } : undefined
    return { workspaceId: parsed.workspaceId, ...(businessHours ? { businessHours } : {}) }
  } catch {
    return null
  }
}
