import * as admin from './admin.ts'
import * as calendar from './calendar.ts'
import * as calls from './calls.ts'
import type { ActionDef } from './define.ts'
import * as notifications from './notifications.ts'
import * as onboarding from './onboarding.ts'
import * as settings from './settings.ts'
import * as team from './team.ts'

export * from './define.ts'
export * from './admin.ts'
export * from './assistant-prompt.ts'
export * from './calendar.ts'
export * from './calls.ts'
export * from './notifications.ts'
export * from './onboarding.ts'
export * from './settings.ts'
export * from './team.ts'

const all = [
  calls.callMarkDone,
  calls.callMarkNotDone,
  calls.callMarkRead,
  calls.callMarkUnread,
  calls.callRemind,
  calls.callAssign,
  calls.callClearReminder,
  calls.callDelete,
  calls.callRestore,
  calls.callMarkSpam,
  calls.callMarkNotSpam,
  calls.callSetActionItems,
  calls.callStart,
  calls.callAppendTranscript,
  calls.callFinish,
  calls.callTakeMessage,
  calls.callFlagUrgent,
  calls.callStartTest,
  calls.callFindForTest,
  calls.callSetRecording,
  settings.contactUpdate,
  settings.contactBlock,
  settings.contactUnblock,
  settings.contactCreate,
  settings.contactDelete,
  settings.contactRestore,
  settings.assistantUpdate,
  settings.assistantCreate,
  settings.assistantDelete,
  settings.phoneNumberSetup,
  settings.phoneNumberUpdate,
  settings.phoneNumberRelease,
  settings.assistantStartTestCall,
  settings.workspaceGetSettings,
  settings.workspaceUpdateSettings,
  settings.businessHoursSet,
  notifications.notificationsGet,
  notifications.notificationsUpdate,
  notifications.notificationsSetDefaults,
  calendar.calendarFindSlots,
  calendar.appointmentBook,
  calendar.appointmentCancel,
  calendar.appointmentReschedule,
  calendar.appointmentTypeUpsert,
  calendar.appointmentTypeDelete,
  calendar.calendarConnectStart,
  calendar.calendarConnectFinish,
  calendar.calendarListCalendars,
  calendar.calendarDisconnect,
  calendar.assistantCalendarAdd,
  calendar.assistantCalendarUpdate,
  calendar.assistantCalendarSetDefault,
  calendar.assistantCalendarRemove,
  admin.providerSetKeys,
  admin.providerClearKeys,
  admin.providerSetActive,
  admin.providerTest,
  admin.userInvite,
  admin.userDisable,
  admin.userEnable,
  admin.workspaceDisable,
  admin.workspaceEnable,
  admin.instanceAdminGrant,
  admin.instanceAdminRevoke,
  admin.userImpersonate,
  admin.impersonationStop,
  team.teamList,
  team.teamInvite,
  team.teamResendInvite,
  team.teamRevokeInvite,
  team.teamSetRole,
  team.teamRemoveMember,
  onboarding.onboardingSetStep,
] as ActionDef[]

/** The registry: every action by name. */
export const actions: ReadonlyMap<string, ActionDef> = new Map(all.map(a => [a.name, a]))

/** What `POST /v1/actions/<name>` returns on success: the rows the action wrote. */
export type ActionResult = {
  ok: true
  rows: Partial<Record<import('@linedesk/db/types').TableName, Record<string, unknown>[]>>
  data?: Record<string, unknown>
}
export type ActionRejection = { ok: false; error: string }
