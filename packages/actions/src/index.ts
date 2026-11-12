import * as admin from './admin.ts'
import * as apiKeys from './api-keys.ts'
import * as assistantVersions from './assistant-versions.ts'
import * as calendar from './calendar.ts'
import * as callExport from './call-export.ts'
import * as carrier from './carrier.ts'
import * as calls from './calls.ts'
import * as evaluations from './evaluations.ts'
import * as insights from './insights.ts'
import type { ActionDef } from './define.ts'
import * as knowledge from './knowledge.ts'
import * as liveCall from './live-call.ts'
import * as membership from './membership.ts'
import * as notifications from './notifications.ts'
import * as onboarding from './onboarding.ts'
import * as sample from './sample.ts'
import * as settings from './settings.ts'
import * as star from './star.ts'
import * as team from './team.ts'
import * as transfer from './transfer.ts'
import * as voices from './voices.ts'
import * as webhooks from './webhooks.ts'

export * from './define.ts'
export * from './agent-token.ts'
export * from './client.ts'
export * from './input-errors.ts'
export * from './admin.ts'
export * from './api-keys.ts'
export * from './assistant-prompt.ts'
export * from './assistant-versions.ts'
export * from './calendar.ts'
export * from './call-export.ts'
export * from './carrier.ts'
export * from './calls.ts'
export * from './evaluations.ts'
export * from './insights.ts'
export * from './knowledge.ts'
export * from './languages.ts'
export * from './live-call.ts'
export * from './spoken-lines.ts'
export * from './membership.ts'
export * from './notifications.ts'
export * from './onboarding.ts'
export * from './openapi.ts'
export * from './sample.ts'
export * from './settings.ts'
export * from './star.ts'
export * from './team.ts'
export * from './transfer.ts'
export * from './voices.ts'
export * from './webhooks.ts'

const all = [
  calls.callMarkDone,
  calls.callMarkNotDone,
  calls.callMarkRead,
  calls.callMarkUnread,
  calls.callRemind,
  calls.callAssign,
  calls.memberList,
  calls.callClearReminder,
  calls.callDelete,
  calls.callRestore,
  calls.callMarkSpam,
  calls.callMarkNotSpam,
  calls.callSetActionItems,
  calls.callSetUrgency,
  callExport.callExport,
  calls.callStart,
  calls.callAppendTranscript,
  calls.callFinish,
  calls.callTakeMessage,
  calls.callFlagUrgent,
  calls.callStartTest,
  calls.callFindForTest,
  calls.callStartRecording,
  calls.callSetRecording,
  transfer.callTransfer,
  liveCall.callListen,
  liveCall.callTakeOver,
  settings.contactUpdate,
  settings.contactBlock,
  settings.contactUnblock,
  settings.contactCreate,
  settings.contactDelete,
  settings.contactRestore,
  settings.contactImport,
  settings.contactMerge,
  settings.assistantUpdate,
  settings.assistantCreate,
  settings.assistantDelete,
  assistantVersions.assistantVersions,
  assistantVersions.assistantVersion,
  assistantVersions.assistantRestoreVersion,
  voices.voiceOptions,
  voices.voiceCatalog,
  voices.voiceClone,
  voices.voiceCloningGet,
  voices.voiceCloningSet,
  settings.phoneNumberSetup,
  settings.phoneNumberUpdate,
  settings.phoneNumberRelease,
  carrier.carrierSet,
  carrier.carrierGet,
  carrier.carrierTest,
  carrier.carrierTransferTrunk,
  carrier.carrierProvisionTransferTrunk,
  settings.assistantStartTestCall,
  settings.workspaceGetSettings,
  settings.workspaceUpdateSettings,
  settings.businessHoursSet,
  settings.closedDaysSet,
  sample.sampleAdd,
  sample.sampleRemove,
  notifications.notificationsGet,
  notifications.notificationsUpdate,
  notifications.notificationsSetDefaults,
  notifications.pushSubscribe,
  notifications.pushUnsubscribe,
  star.starPromptAnswer,
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
  apiKeys.apiKeyCreate,
  apiKeys.apiKeyList,
  apiKeys.apiKeyRevoke,
  admin.providerSetKeys,
  admin.providerClearKeys,
  admin.providerSetActive,
  admin.providerTest,
  admin.userInvite,
  admin.userDisable,
  admin.userEnable,
  admin.workspaceDisable,
  admin.workspaceEnable,
  admin.workspaceSetSpendingCap,
  admin.instanceAdminGrant,
  admin.userResetPasskeys,
  admin.instanceAdminRevoke,
  admin.userImpersonate,
  admin.impersonationStop,
  team.teamList,
  team.teamInvite,
  team.teamResendInvite,
  team.teamRevokeInvite,
  team.teamSetRole,
  team.teamRemoveMember,
  team.teamLeave,
  membership.invitationListMine,
  membership.invitationAccept,
  membership.invitationDecline,
  membership.membershipAdd,
  membership.membershipSetRole,
  membership.membershipRemove,
  membership.invitationRevoke,
  membership.invitationResend,
  onboarding.onboardingSetStep,
  evaluations.callGetEvaluation,
  evaluations.callListEvaluations,
  evaluations.callEvaluate,
  insights.insightsGet,
  webhooks.webhookCreate,
  webhooks.webhookUpdate,
  webhooks.webhookDelete,
  webhooks.webhookTest,
  webhooks.webhookDeliveries,
  knowledge.knowledgeImport,
  knowledge.knowledgeQuestionAnswer,
  knowledge.knowledgeQuestionDismiss,
] as ActionDef[]

/** The registry: every action by name. */
export const actions: ReadonlyMap<string, ActionDef> = new Map(all.map(a => [a.name, a]))

/** What `POST /v1/actions/<name>` returns on success: the rows the action wrote. */
export type ActionResult = {
  ok: true
  rows: Partial<Record<import('@linedesk/db/types').TableName, Record<string, unknown>[]>>
  /** Ids of synced rows the action deleted, so browsers drop them at once instead of at the next read sync. */
  deleted?: Partial<Record<import('@linedesk/db/types').TableName, string[]>>
  data?: Record<string, unknown>
}
/**
 * What `POST /v1/actions/<name>` returns when it does not run the action: 403 with `code: 'forbidden'`
 * when this caller may not do it, 409 when the data's state does not allow it, 422 for invalid input.
 */
export type ActionRejection = { ok: false; error: string; code?: string }
