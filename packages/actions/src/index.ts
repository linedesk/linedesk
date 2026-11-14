import * as admin from './admin.ts'
import * as agentSetup from './agent-setup.ts'
import * as installSetup from './install-setup.ts'
import * as apiKeys from './api-keys.ts'
import * as assistantVersions from './assistant-versions.ts'
import * as branding from './branding.ts'
import * as business from './business.ts'
import * as calendar from './calendar.ts'
import * as callExport from './call-export.ts'
import * as carrier from './carrier.ts'
import * as calls from './calls.ts'
import * as evaluations from './evaluations.ts'
import * as forwarding from './forwarding.ts'
import * as insights from './insights.ts'
import type { ActionDef } from './define.ts'
import * as knowledge from './knowledge.ts'
import * as liveCall from './live-call.ts'
import * as membership from './membership.ts'
import * as notifications from './notifications.ts'
import * as onboarding from './onboarding.ts'
import * as providerHealth from './provider-health.ts'
import * as sample from './sample.ts'
import * as settings from './settings.ts'
import * as star from './star.ts'
import * as team from './team.ts'
import * as transfer from './transfer.ts'
import * as voiceFailure from './voice-failure.ts'
import * as voices from './voices.ts'
import * as webhooks from './webhooks.ts'

export * from './define.ts'
export * from './agent-token.ts'
export * from './area-codes.ts'
export * from './client.ts'
export * from './input-errors.ts'
export * from './admin.ts'
export * from './agent-setup.ts'
export * from './install-setup.ts'
export * from './api-keys.ts'
export * from './assistant-prompt.ts'
export * from './assistant-versions.ts'
export * from './branding.ts'
export * from './business.ts'
export * from './calendar.ts'
export * from './call-export.ts'
export * from './carrier.ts'
export * from './calls.ts'
export * from './evaluations.ts'
export * from './forwarding.ts'
export * from './forwarding-guides.ts'
export * from './insights.ts'
export * from './knowledge.ts'
export * from './languages.ts'
export * from './live-call.ts'
export * from './spoken-lines.ts'
export * from './membership.ts'
export * from './notifications.ts'
export * from './onboarding.ts'
export * from './openapi.ts'
export * from './provider-health.ts'
export * from './sample.ts'
export * from './settings.ts'
export * from './provider-status.ts'
export * from './setup-state.ts'
export * from './star.ts'
export * from './team.ts'
export * from './transfer.ts'
export * from './voice-failure.ts'
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
  calls.callRecordTimings,
  voiceFailure.callReportVoiceFailure,
  calls.callTakeMessage,
  calls.callFlagUrgent,
  calls.callStartTest,
  calls.callFindForTest,
  calls.callListNumbers,
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
  settings.voicePipelinePolicyGet,
  settings.voicePipelinePolicySet,
  branding.brandingSet,
  settings.phoneNumberSetup,
  settings.phoneNumberListCarrierNumbers,
  settings.phoneNumberUpdate,
  settings.phoneNumberRelease,
  forwarding.phoneNumberLookupLine,
  forwarding.phoneNumberCheckForwarding,
  forwarding.phoneNumberForwardingCheck,
  carrier.carrierSet,
  carrier.carrierGet,
  carrier.carrierTest,
  carrier.carrierTransferTrunk,
  carrier.carrierProvisionTransferTrunk,
  settings.assistantStartTestCall,
  settings.workspaceGetSettings,
  settings.workspaceUpdateSettings,
  settings.workspaceRename,
  settings.workspaceDeleteOwn,
  settings.workspaceDeletePreview,
  settings.businessHoursSet,
  settings.closedDaysSet,
  settings.holidaysLookup,
  settings.holidaysSet,
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
  installSetup.installSetProgress,
  installSetup.providerTryOut,
  installSetup.providerConfirmEmail,
  agentSetup.agentSetupCreateKey,
  agentSetup.agentSetupRevoke,
  admin.providerSetKeys,
  admin.providerClearKeys,
  admin.providerSetActive,
  admin.providerTest,
  admin.providerConnectOneKey,
  providerHealth.providerReportFailure,
  providerHealth.providerReportOk,
  admin.userInvite,
  admin.userDisable,
  admin.userEnable,
  admin.workspaceDisable,
  admin.workspaceDelete,
  admin.workspaceEnable,
  admin.workspaceSetSpendingCap,
  admin.instanceAdminGrant,
  admin.userResetPasskeys,
  admin.instanceAdminRevoke,
  admin.userImpersonate,
  admin.impersonationStop,
  admin.setupEmailsGet,
  admin.setupEmailsSet,
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
  onboarding.onboardingRecordEvent,
  onboarding.onboardingGoLiveChecklist,
  onboarding.onboardingDismissGoLiveChecklist,
  onboarding.onboardingReopenGoLiveChecklist,
  onboarding.onboardingSkipGoLiveStep,
  onboarding.onboardingRemindGoLiveStep,
  onboarding.onboardingRestoreGoLiveStep,
  evaluations.callGetEvaluation,
  evaluations.callListEvaluations,
  evaluations.callEvaluate,
  insights.insightsGet,
  webhooks.webhookCreate,
  webhooks.webhookUpdate,
  webhooks.webhookDelete,
  webhooks.webhookTest,
  webhooks.webhookDeliveries,
  webhooks.callLookUpCaller,
  webhooks.callAskWebhook,
  knowledge.knowledgeImport,
  knowledge.knowledgeQuestionAnswer,
  knowledge.knowledgeQuestionDismiss,
  business.businessSearch,
  business.businessImport,
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
