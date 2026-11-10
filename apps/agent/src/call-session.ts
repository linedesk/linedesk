// One call as the agent sees it: start, append transcript segments, finish.
import { callAppendTranscript, callFinish, callStart, callStartTest } from '@callfront/actions'
import type { Assistant, Contact, ToolEvent } from '@callfront/db/types'
import type { z } from 'zod'
import type { ApiClient } from './api-client.ts'

export type Speaker = z.input<typeof callAppendTranscript.input>['speaker']
export type CallResult = Omit<z.input<typeof callFinish.input>, 'callId'>

export interface CallSession {
  callId: string
  workspaceId: string
  assistant: Assistant | null
  contact: Contact
  append(speaker: Speaker, text: string, toolEvent?: ToolEvent): Promise<void>
  finish(result: CallResult): Promise<void>
}

type StartData = Pick<CallSession, 'callId' | 'workspaceId' | 'assistant' | 'contact'>

/** Where a call comes from: a phone (the workspace is the dialled number's) or a test from the web app. */
export type CallOrigin = { kind: 'phone'; from: string; to: string; room?: string } | { kind: 'test'; workspaceId: string; room: string }

export async function startCall(api: ApiClient, origin: CallOrigin): Promise<CallSession> {
  const { data } = origin.kind === 'phone'
    ? await api.run(callStart, { from: origin.from, to: origin.to, room: origin.room })
    : await api.run(callStartTest, { room: origin.room }, origin.workspaceId)
  const { callId, workspaceId, assistant, contact } = data as StartData
  const startedAt = Date.now()
  return {
    callId, workspaceId, assistant, contact,
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
  if (test) return { kind: 'test', workspaceId: test.workspaceId, room }
  const from = attributes['sip.phoneNumber']
  const to = attributes['sip.trunkPhoneNumber']
  if (!from || !to) throw new Error('participant has no sip.phoneNumber / sip.trunkPhoneNumber attributes')
  return { kind: 'phone', from, to, room }
}

/** The workspace of a test room the API signed, or null for any other room. */
export function parseTestMetadata(metadata: string): { workspaceId: string } | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; workspaceId?: unknown }
    return parsed.source === 'test' && typeof parsed.workspaceId === 'string' && parsed.workspaceId ? { workspaceId: parsed.workspaceId } : null
  } catch {
    return null
  }
}
