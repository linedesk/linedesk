import * as admin from './admin.ts'
import * as agentSetup from './agent-setup.ts'
import * as authenticator from './authenticator.ts'
import * as installSetup from './install-setup.ts'
import * as apiKeys from './api-keys.ts'
import * as apps from './apps.ts'
import * as personalKeys from './personal-keys.ts'
import * as oauth from './oauth.ts'
import * as records from './records.ts'
import * as assistantVersions from './assistant-versions.ts'
import * as billing from './billing.ts'
import * as billingAdmin from './billing-admin.ts'
import * as signup from './signup.ts'
import * as billingCheckout from './billing-checkout.ts'
import * as billingPage from './billing-page.ts'
import * as branding from './branding.ts'
import * as business from './business.ts'
import * as calendar from './calendar.ts'
import * as callExport from './call-export.ts'
import * as carrier from './carrier.ts'
import * as calls from './calls.ts'
import * as emailRouting from './email-routing.ts'
import * as evaluations from './evaluations.ts'
import * as forwarding from './forwarding.ts'
import * as insights from './insights.ts'
import * as integrations from './integrations.ts'
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
import * as systemPrompt from './system-prompt.ts'
import * as team from './team.ts'
import * as transfer from './transfer.ts'
import * as outbound from './outbound.ts'
import * as voiceFailure from './voice-failure.ts'
import * as voices from './voices.ts'
import * as webhooks from './webhooks.ts'
import * as workspaceIcon from './workspace-icon.ts'
import * as userAvatar from './user-avatar.ts'
import * as workspaceCreation from './workspace-creation.ts'

export * from './define.ts'
export * from './words.ts'
export * from './agent-token.ts'
export * from './area-codes.ts'
export * from './nearby-area-codes.ts'
export * from './client.ts'
export * from './input-errors.ts'
export * from './admin.ts'
export * from './agent-setup.ts'
export * from './authenticator.ts'
export * from './install-setup.ts'
export * from './api-keys.ts'
export * from './apps.ts'
export * from './personal-keys.ts'
export * from './oauth.ts'
export * from './records.ts'
export * from './assistant-prompt.ts'
export * from './prompt-texts.ts'
export * from './system-prompt.ts'
export * from './assistant-versions.ts'
export * from './billing.ts'
export * from './billing-admin.ts'
export * from './signup.ts'
export * from './billing-checkout.ts'
export * from './billing-page.ts'
export * from './branding.ts'
export * from './business.ts'
export * from './calendar.ts'
export * from './call-export.ts'
export * from './carrier.ts'
export * from './calls.ts'
export * from './email-routing.ts'
export * from './evaluations.ts'
export * from './forwarding.ts'
export * from './forwarding-guides.ts'
export * from './insights.ts'
export * from './integrations.ts'
export * from './knowledge.ts'
export * from './languages.ts'
export * from './live-call.ts'
export * from './spoken-lines.ts'
export * from './membership.ts'
export * from './notifications.ts'
export * from './onboarding.ts'
export * from './openapi.ts'
export * from './phone-input.ts'
export * from './workspace-locale.ts'
export * from './provider-health.ts'
export * from './sample.ts'
export * from './settings.ts'
export * from './provider-status.ts'
export * from './setup-state.ts'
export * from './star.ts'
export * from './team.ts'
export * from './transfer.ts'
export * from './outbound.ts'
export * from './voice-failure.ts'
export * from './voices.ts'
export * from './usage-level.ts'
export * from './webhooks.ts'
export * from './workspace-icon.ts'
export * from './user-avatar.ts'
export * from './workspace-creation.ts'
export * from './rights.ts'

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
  calls.callCorrectTranscript,
  calls.callFinalize,
  transfer.callTransfer,
  outbound.outboundCountriesView,
  outbound.outboundCountriesGet,
  outbound.outboundCountriesSet,
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
  emailRouting.emailRoutingGet,
  emailRouting.emailRecipientAdd,
  emailRouting.emailRecipientResend,
  emailRouting.emailRecipientRemove,
  emailRouting.emailRecipientRestore,
  emailRouting.assistantPreviewEmailRouting,
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
  systemPrompt.systemPromptGet,
  systemPrompt.systemPromptSetPart,
  systemPrompt.systemPromptResetPart,
  settings.afterCallTranscriptGet,
  settings.afterCallTranscriptSet,
  branding.brandingSet,
  settings.phoneNumberSetup,
  settings.phoneNumberListCarrierNumbers,
  settings.phoneNumberSearchNearby,
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
  settings.workspaceSetAllowPremium,
  settings.workspaceSetAllowUltra,
  settings.workspaceRename,
  settings.workspaceDeleteOwn,
  settings.workspaceDeletePreview,
  workspaceIcon.workspaceSetIcon,
  workspaceIcon.workspaceRemoveIcon,
  userAvatar.accountSetAvatar,
  userAvatar.accountRemoveAvatar,
  authenticator.accountAuthenticatorStart,
  authenticator.accountAuthenticatorConfirm,
  authenticator.accountAuthenticatorCheck,
  authenticator.accountAuthenticatorRemove,
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
  calendar.calendarConnectWithPassword,
  calendar.calendarToolsGet,
  calendar.calendarToolsSet,
  calendar.calendarListCalendars,
  calendar.calendarDisconnect,
  apps.appConnectStart,
  apps.appConnectFinish,
  apps.appDisconnect,
  apps.appUpdateSettings,
  apps.appPushes,
  calendar.assistantCalendarAdd,
  calendar.assistantCalendarUpdate,
  calendar.assistantCalendarSetDefault,
  calendar.assistantCalendarRemove,
  apiKeys.apiKeyCreate,
  apiKeys.apiKeyList,
  apiKeys.apiKeyRevoke,
  personalKeys.personalKeyCreate,
  personalKeys.personalKeyList,
  personalKeys.personalKeyRevoke,
  oauth.oauthDescribe,
  oauth.oauthApprove,
  records.recordsList,
  installSetup.installSetProgress,
  installSetup.providerTryOut,
  installSetup.providerConfirmEmail,
  agentSetup.agentSetupCreateKey,
  agentSetup.agentSetupRevoke,
  agentSetup.agentSetupEndOwnAccess,
  agentSetup.agentSetupCreateWorkspaceKey,
  agentSetup.agentSetupRevokeWorkspace,
  admin.providerSetKeys,
  admin.providerClearKeys,
  admin.providerSetActive,
  admin.providerTest,
  admin.providerConnectOneKey,
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
  admin.userIssuePasskeyEnrolment,
  admin.instanceAdminRevoke,
  admin.userImpersonate,
  admin.impersonationStop,
  admin.setupEmailsGet,
  admin.setupEmailsSet,
  billing.billingEnabledGet,
  billing.billingEnabledSet,
  billing.billingProcessStripeEvent,
  billing.billingSettleInvoice,
  billing.billingReprocessEvent,
  billingAdmin.billingAdminBills,
  billingAdmin.billingAdminBill,
  billingAdmin.billingAdminEvents,
  billingAdmin.billingAdminReview,
  billingAdmin.billingRulesGet,
  billingAdmin.signupGetSelfServe,
  billingAdmin.billingCredit,
  billingAdmin.billingAdminSetStatus,
  billingAdmin.billingRefund,
  billingAdmin.billingSetCap,
  billingAdmin.billingSetConcurrency,
  billingAdmin.billingMoveWorkspace,
  billingAdmin.billingTransferOwner,
  billingAdmin.billingReviewHold,
  billingAdmin.billingRulesSet,
  billingAdmin.signupSetSelfServe,
  billingAdmin.signupSetRules,
  billing.billingState,
  billing.billingPortOutInfo,
  billing.billingRecordPortOut,
  billing.billingHandOver,
  signup.accountSignUp,
  billingCheckout.billingStartCheckout,
  billingCheckout.billingConfirmCheckout,
  billingCheckout.billingStartTopUp,
  billingCheckout.billingCancel,
  billingCheckout.billingResume,
  billingPage.billingOverview,
  billingPage.billingSetAutoRecharge,
  billingPage.billingSetRechargeCap,
  billingPage.billingOpenPortal,
  billingPage.billingRetryRecharge,
  billingPage.billingWorkspaceUsage,
  admin.impersonationEmailsGet,
  admin.impersonationEmailsSet,
  workspaceCreation.workspaceCreate,
  team.teamList,
  team.teamInvite,
  team.teamResendInvite,
  team.teamRevokeInvite,
  team.teamSetRole,
  team.teamTransferOwnership,
  team.teamRemoveMember,
  team.teamLeave,
  team.teamGetMember,
  team.teamUpdateMemberProfile,
  team.teamSetMemberAvatar,
  team.teamRemoveMemberAvatar,
  team.teamUpdateMemberNotifications,
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
  evaluations.evaluationMarkDone,
  evaluations.evaluationReopen,
  evaluations.evaluationListQuestions,
  insights.insightsGet,
  webhooks.webhookCreate,
  webhooks.webhookUpdate,
  webhooks.webhookDelete,
  webhooks.webhookTest,
  webhooks.webhookDeliveries,
  integrations.integrationSubscribe,
  integrations.integrationUnsubscribe,
  integrations.integrationList,
  integrations.integrationRemove,
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
