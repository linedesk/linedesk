import * as calendar from './calendar.ts'
import * as calls from './calls.ts'
import type { ActionDef } from './define.ts'
import * as settings from './settings.ts'

export * from './define.ts'
export * from './calendar.ts'
export * from './calls.ts'
export * from './settings.ts'

const all = [
  calls.callMarkDone, calls.callMarkNotDone, calls.callMarkRead, calls.callMarkUnread, calls.callRemind,
  calls.callClearReminder, calls.callDelete, calls.callRestore, calls.callSetActionItems,
  calls.callStart, calls.callAppendTranscript, calls.callFinish, calls.callTakeMessage, calls.callFlagUrgent,
  settings.contactUpdate, settings.assistantUpdate, settings.phoneNumberSetup,
  calendar.calendarFindSlots,
] as ActionDef[]

/** The registry: every action by name. */
export const actions: ReadonlyMap<string, ActionDef> = new Map(all.map(a => [a.name, a]))

/** What `POST /v1/actions/<name>` returns on success: the rows the action wrote. */
export type ActionResult = { ok: true; rows: Partial<Record<import('@callfront/db/types').TableName, Record<string, unknown>[]>>; data?: Record<string, unknown> }
export type ActionRejection = { ok: false; error: string }
