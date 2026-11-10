// One call as the agent sees it: start, append transcript segments, finish.
import { callAppendTranscript, callFinish, callStart } from '@callfront/actions'
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

export async function startCall(api: ApiClient, call: { from: string; to: string; room?: string }): Promise<CallSession> {
  const { data } = await api.run(callStart, call)
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
