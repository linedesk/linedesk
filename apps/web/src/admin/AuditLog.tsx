// Server admin › Audit log: who did what on this install, newest first. Sign-ins with their method,
// sign-in methods added or removed, admin actions, team changes, provider keys and impersonation.
// Kept forever; filters by kind, person, workspace and dates; "Show older" pages back.
import { CALL_QUALITY_LABELS, type CallQuality } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useCallback, useEffect, useState } from 'react'
import { dateTimeLabel } from '../time.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { DateInput, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { type AdminWorkspace, type AuditEntry, type AuditFilter, type AuditKind, loadAudit } from './api.ts'
import { errorText } from './notify.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { EMPTY } from './parts.tsx'

type Translate = ReturnType<typeof i18n>['t']
/** The active language's `t`, looked up on each call (the language can change while the module stays loaded). */
const t = ((...args: Parameters<Translate>) => i18n().t(...args)) as Translate

const kinds: { value: AuditKind | 'all'; label: MessageKey }[] = [
  { value: 'all', label: msg('admin.audit.kind.all') },
  { value: 'sign_in', label: msg('admin.audit.kind.signIn') },
  { value: 'account', label: msg('admin.audit.kind.account') },
  { value: 'admin', label: msg('admin.audit.kind.admin') },
  { value: 'team', label: msg('admin.audit.kind.team') },
  { value: 'keys', label: msg('admin.audit.kind.keys') },
  { value: 'integrations', label: msg('admin.audit.kind.integrations') },
  { value: 'partners', label: msg('admin.audit.kind.partners') },
  { value: 'impersonation', label: msg('admin.audit.kind.impersonation') },
]

const methods: Record<string, MessageKey> = {
  password: msg('admin.audit.method.password'),
  email_code: msg('admin.audit.method.emailCode'),
  passkey: msg('admin.audit.method.passkey'),
  oidc: msg('admin.audit.method.oidc'),
  email_link: msg('admin.audit.method.emailLink'),
}
/** Brand names stay as they are. */
const brandMethods: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub' }
const method = (m: string | null) => {
  if (!m) return ''
  const key = methods[m]
  return key ? t(key) : (brandMethods[m] ?? m)
}

/** For messages with an optional name: `known` is "yes" when there is one. */
const known = (value: unknown) => (value === undefined || value === null || value === '' ? 'no' : 'yes')
/** A role as the messages select on it. */
const roleOf = (role: unknown) => (role === 'owner' || role === 'admin' ? role : 'member')

/** Why an admin signed in as a user (user.impersonate's reason), or null: entries from before it was asked for have none. */
export function auditReason(e: Pick<AuditEntry, 'what' | 'input'>): string | null {
  const reason = (e.input as { reason?: unknown } | null)?.reason
  return REASONED.has(e.what) && typeof reason === 'string' && reason.trim()
    ? t('admin.audit.reason', { reason: reason.trim() })
    : null
}

/** Actions that ask the admin why (support access; Server admin › Billing): the log shows the reason under them. */
const REASONED = new Set([
  'user.impersonate',
  'billing.credit',
  'billing.adminSetStatus',
  'billing.refund',
  'billing.setCap',
  'billing.setConcurrency',
  'billing.moveWorkspace',
  'billing.transferOwner',
  'billing.reviewHold',
  'billingRules.set',
  'signup.setSelfServe',
  'signup.setRules',
  'billing.reprocessEvent',
])

/** What happened, in a few words. */
export function auditLabel(
  e: Pick<
    AuditEntry,
    | 'what'
    | 'method'
    | 'input'
    | 'subject'
    | 'transferChanges'
    | 'usageLevelChange'
    | 'emailRoutingChanges'
    | 'apiKeyName'
    | 'ruleChanges'
    | 'removedPeople'
  >,
): string {
  const input = (e.input ?? {}) as Record<string, unknown>
  const subject = e.subject?.email ?? ''
  const who = { who: subject, known: known(subject) }
  const provider = { provider: String(input.provider ?? ''), known: known(input.provider) }
  const name = { name: typeof input.name === 'string' ? input.name : '', named: known(input.name) }
  switch (e.what) {
    case 'sign_in':
      return t('admin.audit.signIn', { method: method(e.method) })
    case 'sign_up':
      return t('admin.audit.signUp', { method: method(e.method) })
    case 'provider_linked':
      return e.method === 'password'
        ? t('admin.audit.passwordSet')
        : t('admin.audit.signInAdded', { method: method(e.method) })
    case 'passkey_added':
      return t('admin.audit.passkeyAdded')
    case 'passkey_removed':
      return t('admin.audit.passkeyRemoved')
    case 'password_changed':
      return t('admin.audit.passwordChanged')
    case 'email_changed':
      return t('admin.audit.emailChanged', { email: e.method ?? '', known: known(e.method) })
    case 'invitation_accepted':
      return e.method === 'admin_created' ? t('admin.audit.joinedByAdmin') : t('admin.audit.joined')
    case 'sign_up_undone':
      return t('admin.audit.signUpUndone')
    case 'invitation_reassigned':
      // The subject is the owner it passed to, while that account exists.
      return e.subject?.email
        ? t('admin.audit.invitationReassignedTo', { email: e.method ?? '', owner: e.subject.email })
        : t('admin.audit.invitationReassigned', { email: e.method ?? '' })
    case 'invitation_withdrawn':
      return t('admin.audit.invitationWithdrawn', { email: e.method ?? '' })
    case 'call_routing_reset':
      return t('admin.audit.callRoutingReset')
    // What an unproven account set up, removed when its address was proven (LIN-523); `method` names it.
    case 'api_key_dropped':
      return t('admin.audit.apiKeyDropped', { name: e.method ?? '', named: known(e.method) })
    case 'personal_key_dropped':
      return t('admin.audit.personalKeyDropped', { name: e.method ?? '', named: known(e.method) })
    case 'zapier_subscription_dropped':
      return t('admin.audit.zapierSubscriptionDropped')
    case 'setup_link_dropped':
      return t('admin.audit.setupLinkDropped')
    case 'webhook_dropped':
      return t('admin.audit.webhookDropped', { host: e.method ?? '', known: known(e.method) })
    case 'calendar_dropped': {
      const calendar = calendarNames[String(e.method)]
      return t('admin.audit.calendarDropped', { calendar: calendar ?? '', known: known(calendar) })
    }
    case 'app_dropped': {
      const app = appName(e.method)
      return t('admin.audit.appDropped', { app: app ?? '', known: known(app) })
    }
    case 'mail_dropped': {
      const mailbox = mailboxName(e.method)
      return t('admin.audit.mailDropped', { provider: mailbox ?? '', known: known(mailbox) })
    }
    case 'user.impersonate':
      // Whom it was: kept by the handler since the reason was added; older entries have none.
      return subject ? t('admin.audit.impersonateAs', { who: subject }) : t('admin.audit.impersonate')
    case 'impersonationEmails.set':
      return input.on === true ? t('admin.audit.impersonationEmailsOn') : t('admin.audit.impersonationEmailsOff')
    case 'impersonation.stop':
      return t('admin.audit.impersonationStop')
    case 'impersonation.setEdits':
      return input.on === true ? t('admin.audit.impersonationEditsOn') : t('admin.audit.impersonationEditsOff')
    case 'provider.setKeys':
      return t('admin.audit.providerSetKeys', provider)
    case 'provider.clearKeys':
      return t('admin.audit.providerClearKeys', provider)
    case 'branding.set':
      return input.poweredBy === false
        ? t('admin.audit.brandingSetPoweredByHidden', name)
        : t('admin.audit.brandingSet', name)
    case 'provider.setActive':
      return t('admin.audit.providerSetActive', {
        ...provider,
        category: String(input.category ?? ''),
        hasCategory: known(input.category),
      })
    case 'team.setRole':
    case 'membership.setRole':
      return t('admin.audit.setRole', { ...who, role: roleOf(input.role) })
    case 'team.invite':
      return t('admin.audit.teamInvite', { email: String(input.email ?? ''), known: known(input.email) })
    case 'team.resendInvite':
    case 'invitation.resend':
      return t('admin.audit.inviteResent', who)
    case 'team.revokeInvite':
    case 'invitation.revoke':
      return t('admin.audit.inviteRevoked', who)
    case 'team.removeMember':
    case 'membership.remove':
      return t('admin.audit.memberRemoved', who)
    case 'team.leave':
      return t('admin.audit.left')
    case 'team.updateMemberProfile':
      return t('admin.audit.memberNameChanged', who)
    case 'team.setMemberAvatar':
      return t('admin.audit.memberAvatarSet', who)
    case 'team.removeMemberAvatar':
      return t('admin.audit.memberAvatarRemoved', who)
    case 'team.updateMemberNotifications':
      return t('admin.audit.memberNotificationsChanged', { ...who, fields: changedFields(input) })
    case 'user.invite': {
      const email = input.email ?? subject
      const args = { email: String(email ?? ''), known: known(email), admin: input.admin ? 'yes' : 'no' }
      return input.workspaceId
        ? t('admin.audit.userInviteToWorkspace', { ...args, role: roleOf(input.role ?? 'member') })
        : t('admin.audit.userInvite', args)
    }
    case 'membership.add':
      return t('admin.audit.membershipAdded', { ...who, role: roleOf(input.role) })
    case 'invitation.accept':
      return t('admin.audit.invitationAccepted')
    case 'invitation.decline':
      return t('admin.audit.invitationDeclined')
    case 'apiKey.create':
      return t('admin.audit.apiKeyCreated', name)
    case 'apiKey.revoke':
      return e.apiKeyName ? t('admin.audit.apiKeyRevokedNamed', { name: e.apiKeyName }) : t('admin.audit.apiKeyRevoked')
    case 'workspace.rename':
      return t('admin.audit.workspaceRenamed', name)
    case 'notifications.update':
      return t('admin.audit.notificationsChanged', { fields: changedFields(input) })
    case 'onboarding.setStep':
      return input.step === 'skipped' ? t('admin.audit.onboardingSetAside') : t('admin.audit.onboardingStep')
    case 'webhook.create':
      return t('admin.audit.webhookCreated', hostOf(input.url))
    case 'webhook.update':
      return input.url ? t('admin.audit.webhookChangedTo', hostOf(input.url)) : t('admin.audit.webhookChanged')
    case 'workspace.delete':
      return t('admin.audit.workspaceDeleted', name)
    case 'workspace.purge':
      return t('admin.audit.workspacePurged', name)
    case 'data.purgeDeleted':
      return t('admin.audit.deletedPurged', { calls: Number(input.calls ?? 0), contacts: Number(input.contacts ?? 0) })
    case 'user.resetPasskeys':
      return t('admin.audit.passkeysReset')
    case 'user.issuePasskeyEnrolment':
      return t('admin.audit.passkeyEnrolmentIssued')
    case 'webhook.delete':
      return t('admin.audit.webhookRemoved')
    case 'webhook.test':
      return t('admin.audit.webhookTested')
    case 'agentSetup.endOwnAccess':
      return t('admin.audit.agentSetupEndOwnAccess')
    case 'agentSetup.createKey':
      return t('admin.audit.agentSetupCreateKey')
    case 'feedback.send':
      return t('admin.audit.feedbackSend')
    case 'feedback.resend':
      return t('admin.audit.feedbackResend')
    case 'agentSetup.revoke':
      return t('admin.audit.agentSetupRevoke')
    case 'agentSetup.createWorkspaceKey':
      return t('admin.audit.agentSetupCreateWorkspaceKey')
    case 'agentSetup.revokeWorkspace':
      return t('admin.audit.agentSetupRevokeWorkspace')
    // The Allow step, gone since the one-level setup link; past entries still show.
    case 'agentSetup.confirmPasskey':
      return t('admin.audit.agentSetupConfirmPasskey')
    case 'agentSetup.withdrawPasskey':
      return t('admin.audit.agentSetupWithdrawPasskey')
    case 'provider.connectOneKey':
      return t('admin.audit.providerConnectOneKey', provider)
    case 'carrier.set':
      return t('admin.audit.carrierSet')
    case 'carrier.provisionTransferTrunk':
      return t('admin.audit.carrierTransferTrunk')
    // These take only a user id: the address is the subject their handlers keep; older entries have none.
    case 'user.disable':
      return t('admin.audit.userDisabled', who)
    case 'user.enable':
      return t('admin.audit.userEnabled', who)
    case 'instanceAdmin.grant':
      return t('admin.audit.adminGranted', who)
    case 'instanceAdmin.revoke':
      return t('admin.audit.adminRevoked', who)
    case 'workspace.disable':
      return t('admin.audit.workspaceDisabled')
    case 'workspace.enable':
      return t('admin.audit.workspaceEnabled')
    case 'workspace.setSpendingCap':
      return input.capUsd == null
        ? t('admin.audit.spendingCapRemoved')
        : t('admin.audit.spendingCapSet', { amount: usd(input.capUsd) })
    case 'team.transferOwnership':
      return t('admin.audit.ownershipTransferred', who)
    case 'workspace.deleteOwn':
      return t('admin.audit.workspaceDeletedByOwner', name)
    case 'partner.create':
      return t('admin.audit.partnerCreated', { ...name, ...who })
    case 'partner.approve':
      return t('admin.audit.partnerApproved')
    case 'partner.suspend':
      return t('admin.audit.partnerSuspended')
    case 'partner.update':
      return t('admin.audit.partnerRenamed', name)
    case 'partner.adminMoveClient':
      return input.toPartnerId == null ? t('admin.audit.clientPartnerRemoved') : t('admin.audit.clientPartnerMoved')
    case 'partner.setClientLimit':
      return t('admin.audit.partnerClientLimit', { count: Number(input.limit) })
    case 'partnerMember.invite':
      return t('admin.audit.partnerInvite', who)
    case 'partnerMember.revokeInvite':
      return t('admin.audit.partnerInviteRevoked', who)
    case 'partnerMember.remove':
      return t('admin.audit.partnerMemberRemoved', who)
    case 'partnerInvitation.accept':
      return t('admin.audit.partnerJoined')
    case 'workspace.createForClient':
      return t('admin.audit.clientWorkspaceCreated', name)
    case 'workspace.inviteClientOwner':
      return t('admin.audit.clientOwnerInvited', who)
    case 'partner.releaseClient':
      return e.removedPeople?.length
        ? t('admin.audit.clientReleasedRemoving', { people: fmt().list(e.removedPeople) })
        : t('admin.audit.clientReleased')
    case 'partner.deleteClient':
      return t('admin.audit.clientDeleted', {
        name: typeof input.confirmName === 'string' ? input.confirmName : '',
        named: known(input.confirmName),
      })
    case 'partner.setClientUsageLimit':
      return input.limitUsd == null
        ? t('admin.audit.clientUsageLimitRemoved')
        : t('admin.audit.clientUsageLimitSet', { amount: usd(input.limitUsd) })
    case 'partner.setClientCallQuality':
      return input.on ? t('admin.audit.clientCallQualityOn') : t('admin.audit.clientCallQualityOff')
    case 'workspace.removePartner':
      return e.removedPeople?.length
        ? t('admin.audit.partnerRemovedRemoving', { people: fmt().list(e.removedPeople) })
        : t('admin.audit.partnerRemoved')
    case 'workspace.create':
      return t('admin.audit.workspaceCreated', { ...name, ...who })
    case 'voiceCloning.set':
      return t('admin.audit.voiceCloningSet')
    case 'germanNumbers.set':
      return input.on === true
        ? t('admin.audit.germanNumbersOn')
        : input.on === false
          ? t('admin.audit.germanNumbersOff')
          : t('admin.audit.germanNumbersChanged')
    case 'callQuality.set':
      return t('admin.audit.callQualitySet')
    case 'systemPrompt.setPart':
      return t('admin.audit.systemPromptSet', { part: String(input.key) })
    case 'systemPrompt.resetPart':
      return t('admin.audit.systemPromptReset', { part: String(input.key) })
    case 'afterCallTranscript.set':
      return t('admin.audit.afterCallTranscriptSet')
    case 'setupEmails.set':
      return t('admin.audit.setupEmailsSet')
    case 'founderEmail.set':
      return input.sender ? t('admin.audit.founderEmailOn') : t('admin.audit.founderEmailOff')
    case 'zapierApp.set':
      return input.url ? t('admin.audit.zapierAppSet') : t('admin.audit.zapierAppCleared')
    case 'billingEnabled.set':
      return t('admin.audit.billingEnabledSet', { on: input.on === true ? 'yes' : 'no' })
    case 'billing.credit':
      return t('admin.audit.billingCredit', {
        kind: String(input.kind ?? ''),
        amount: usd(Math.abs(Number(input.amountCents)) / 100),
        negative: Number(input.amountCents) < 0 ? 'yes' : 'no',
      })
    case 'billing.refund':
      return t('admin.audit.billingRefund', { amount: usd(Number(input.amountCents) / 100) })
    case 'billing.adminSetStatus':
      return t('admin.audit.billingStatus', { status: String(input.status ?? '') })
    case 'billing.setCap':
      return t('admin.audit.billingCap', { amount: usd(Number(input.capBaseCents) / 100) })
    case 'billing.setConcurrency':
      return input.concurrentCalls === null
        ? t('admin.audit.billingConcurrencyReset')
        : t('admin.audit.billingConcurrency', { count: Number(input.concurrentCalls) })
    case 'billing.moveWorkspace':
      return t('admin.audit.billingMoveWorkspace')
    case 'billing.transferOwner':
      return t('admin.audit.billingTransferOwner')
    case 'billing.reviewHold':
      return t('admin.audit.billingReview', { decision: input.decision === 'approve' ? 'approve' : 'deny' })
    case 'billingRules.set':
      return t('admin.audit.billingRulesSet')
    case 'signup.setSelfServe':
      return t('admin.audit.selfServeSet', { on: input.on === true ? 'yes' : 'no' })
    case 'signup.setRules':
      return e.ruleChanges?.length
        ? t('admin.audit.signupRulesChanged', { changes: signupRuleChangeList(e.ruleChanges) })
        : t('admin.audit.signupRulesSet')
    case 'billing.startTopUp':
      return t('admin.audit.billing.startTopUp', { amount: usd(Number(input.amountCents) / 100) })
    case 'calendar.connectFinish': {
      const calendar = calendarNames[String(input.provider)]
      return t('admin.audit.calendarConnected', { calendar: calendar ?? '', known: known(calendar) })
    }
    case 'calendar.disconnect':
      return t('admin.audit.calendarDisconnected')
    case 'app.connectFinish': {
      const app = appName(input.app)
      return t('admin.audit.appConnected', { app: app ?? '', known: known(app) })
    }
    case 'app.disconnect': {
      const app = appName(input.app)
      return t('admin.audit.appDisconnected', { app: app ?? '', known: known(app) })
    }
    case 'app.updateSettings':
      return t('admin.audit.appSettingsChanged')
    case 'mail.connectFinish': {
      const mailbox = mailboxName(input.provider)
      return t('admin.audit.mailConnected', { provider: mailbox ?? '', known: known(mailbox) })
    }
    case 'mail.disconnect':
      return t('admin.audit.mailDisconnected')
    case 'phoneNumber.setup':
      return input.purchase ? t('admin.audit.numberBought') : t('admin.audit.numberConnected')
    case 'phoneNumber.release':
      return t('admin.audit.numberReleased')
    case 'outboundCountries.set': {
      const countries = Array.isArray(input.countries) ? input.countries.map(String) : []
      return t('admin.audit.outboundCountriesSet', {
        countries: countries.length ? fmt().list(countries, { type: 'unit', style: 'short' }) : '',
        known: countries.length ? 'yes' : 'no',
      })
    }
    case 'assistant.update':
      if (e.transferChanges)
        return t('admin.audit.transferContactsChanged', { changes: transferChangeList(e.transferChanges) })
      if (e.usageLevelChange)
        return t('admin.audit.usageLevelChanged', { changes: levelChangeList(e.usageLevelChange) })
      if (e.emailRoutingChanges) return emailRoutingLabel(e.emailRoutingChanges)
      // A refused change (no result): its input had the contacts, or the call email rules.
      if (Array.isArray(input.transfers)) return t('admin.audit.transferContactsEdited')
      return 'email_rules' in input || 'email_routing' in input
        ? t('admin.audit.emailRoutingEdited')
        : t('admin.audit.assistantChanged')
    case 'workspace.updateSettings':
      // Listed for the recording notice (audit.ts, RECORDING_NOTICE_CHANGE_KIND); the text itself shows within 90 days.
      if (input.recordingNoticeOn === false) return t('admin.audit.recordingNoticeOff')
      if (input.recordingNoticeOn === true) return t('admin.audit.recordingNoticeOn')
      if ('recordingNotice' in input) return t('admin.audit.recordingNoticeChanged')
      return t('admin.audit.workspaceSettingsChanged')
    case 'assistant.restoreVersion':
      if (e.transferChanges)
        return t('admin.audit.transferContactsRestored', { changes: transferChangeList(e.transferChanges) })
      return e.usageLevelChange
        ? t('admin.audit.usageLevelRestored', { changes: levelChangeList(e.usageLevelChange) })
        : t('admin.audit.assistantRestored')
    default: {
      const plain = plainLabels[e.what]
      // Any other action (done while signed in as someone, with a setup link or a key made during support access):
      // a sentence that still names it.
      return plain ? t(plain) : t('admin.audit.otherAction', { action: e.what })
    }
  }
}

/**
 * Actions whose label needs nothing from the entry: what a setup link (apps/api/src/setup-mcp.ts, SETUP_ACTIONS), support
 * access (impersonation-guard.ts, IMPERSONATION_ALLOWED_WRITES, READS_LOGGED_WHEN_IMPERSONATED) and an API key made
 * during it (the public actions) can do.
 */
const plainLabels: Record<string, MessageKey> = {
  'install.setProgress': msg('admin.audit.installProgress'),
  'workspace.setIcon': msg('admin.audit.workspaceIconSet'),
  'workspace.removeIcon': msg('admin.audit.workspaceIconRemoved'),
  'workspace.updateSettings': msg('admin.audit.workspaceSettingsChanged'),
  'businessHours.set': msg('admin.audit.businessHoursSet'),
  'phoneNumber.update': msg('admin.audit.numberChanged'),
  'phoneNumber.checkForwarding': msg('admin.audit.forwardingChecked'),
  'call.export': msg('admin.audit.callsExported'),
  'call.markRead': msg('admin.audit.call.markRead'),
  'call.markUnread': msg('admin.audit.call.markUnread'),
  'call.markDone': msg('admin.audit.call.markDone'),
  'call.markNotDone': msg('admin.audit.call.markNotDone'),
  'call.remind': msg('admin.audit.call.remind'),
  'call.clearReminder': msg('admin.audit.call.clearReminder'),
  'call.assign': msg('admin.audit.call.assign'),
  'call.delete': msg('admin.audit.call.delete'),
  'call.restore': msg('admin.audit.call.restore'),
  'call.erase': msg('admin.audit.call.erase'),
  'call.markSpam': msg('admin.audit.call.markSpam'),
  'call.markNotSpam': msg('admin.audit.call.markNotSpam'),
  'call.setActionItems': msg('admin.audit.call.setActionItems'),
  'call.setUrgency': msg('admin.audit.call.setUrgency'),
  'contact.create': msg('admin.audit.contact.create'),
  'contact.update': msg('admin.audit.contact.update'),
  'contact.block': msg('admin.audit.contact.block'),
  'contact.unblock': msg('admin.audit.contact.unblock'),
  'contact.delete': msg('admin.audit.contact.delete'),
  'contact.restore': msg('admin.audit.contact.restore'),
  'appointment.book': msg('admin.audit.appointment.book'),
  'appointment.cancel': msg('admin.audit.appointment.cancel'),
  'appointment.reschedule': msg('admin.audit.appointment.reschedule'),
  // Sign-up and the bill's own actions (apps/api/src/audit.ts): what the owner did, never the raw action name.
  'account.signUp': msg('admin.audit.billing.signUp'),
  'account.acceptTerms': msg('admin.audit.billing.acceptTerms'),
  'billing.startCheckout': msg('admin.audit.billing.startCheckout'),
  'billing.confirmCheckout': msg('admin.audit.billing.confirmCheckout'),
  'billing.cancel': msg('admin.audit.billing.cancel'),
  'billing.resume': msg('admin.audit.billing.resume'),
  'billing.setAutoRecharge': msg('admin.audit.billing.setAutoRecharge'),
  'billing.setRechargeCap': msg('admin.audit.billing.setRechargeCap'),
  'billing.openPortal': msg('admin.audit.billing.openPortal'),
  'billing.retryRecharge': msg('admin.audit.billing.retryRecharge'),
  'billing.recordPortOut': msg('admin.audit.billing.recordPortOut'),
  'billing.handOver': msg('admin.audit.billing.handOver'),
  'billing.portOutInfo': msg('admin.audit.billing.portOutInfo'),
  'billing.reprocessEvent': msg('admin.audit.billing.reprocessEvent'),
}

const calendarNames: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' }
/** Connected apps (connectableApps in @linedesk/actions): their names as the Integrations page shows them. */
const appNameKeys: Record<string, MessageKey> = {
  hubspot: msg('settings.integrations.card.hubspot.name'),
  slack: msg('settings.integrations.card.slack.name'),
  jobber: msg('settings.integrations.card.jobber.name'),
  shopify: msg('settings.integrations.card.shopify.name'),
  zoho: msg('settings.integrations.card.zoho.name'),
}
const appName = (app: unknown) => {
  const key = appNameKeys[String(app)]
  return key ? t(key) : undefined
}
const mailboxNameKeys: Record<string, MessageKey> = {
  google: msg('settings.integrations.mail.provider.google'),
  microsoft: msg('settings.integrations.mail.provider.microsoft'),
}
const mailboxName = (provider: unknown) => {
  const key = mailboxNameKeys[String(provider)]
  return key ? t(key) : undefined
}

/** Which transfer contacts a change added, changed and removed: "added Sarah, removed Mike"; a new order alone says so. */
const transferChangeList = ({ added, changed, removed }: NonNullable<AuditEntry['transferChanges']>) => {
  const names = (list: string[]) => fmt().list(list, { type: 'conjunction' })
  const parts = [
    ...(added.length ? [t('admin.audit.transferChange.added', { names: names(added) })] : []),
    ...(changed.length ? [t('admin.audit.transferChange.changed', { names: names(changed) })] : []),
    ...(removed.length ? [t('admin.audit.transferChange.removed', { names: names(removed) })] : []),
  ]
  return parts.length ? fmt().list(parts, { type: 'unit', style: 'short' }) : t('admin.audit.transferChange.reordered')
}

/** A change of the call email instruction: who it added and removed ("added Dave, removed rosa@…"), never its text. */
const emailRoutingLabel = ({ added, removed }: NonNullable<AuditEntry['emailRoutingChanges']>) => {
  const names = (list: string[]) => fmt().list(list, { type: 'conjunction' })
  const parts = [
    ...(added.length ? [t('admin.audit.transferChange.added', { names: names(added) })] : []),
    ...(removed.length ? [t('admin.audit.transferChange.removed', { names: names(removed) })] : []),
  ]
  return parts.length
    ? t('admin.audit.emailRoutingChanged', { changes: fmt().list(parts, { type: 'unit', style: 'short' }) })
    : t('admin.audit.emailRoutingEdited')
}

/** What a change of the usage level changed: "voice model elevenlabs/eleven_flash_v2_5 to elevenlabs/eleven_v3". */
const levelChangeList = ({ before, after }: NonNullable<AuditEntry['usageLevelChange']>) => {
  const shown = (value: string | null) => value ?? t('admin.audit.levelChange.default')
  const parts = (
    [
      ['call_quality', msg('admin.audit.levelChange.callQuality')],
      ['voice_model', msg('admin.audit.levelChange.voiceModel')],
      ['llm_model', msg('admin.audit.levelChange.languageModel')],
      ['realtime_model', msg('admin.audit.levelChange.realtimeModel')],
    ] as const
  )
    .filter(([field]) => (before[field] ?? null) !== (after[field] ?? null))
    .map(([field, key]) => {
      const value = (v: string | null) =>
        field === 'call_quality' && v ? (CALL_QUALITY_LABELS[v as CallQuality] ?? v) : shown(v)
      return t(key, { before: value(before[field] ?? null), after: value(after[field] ?? null) })
    })
  return fmt().list(parts, { type: 'unit', style: 'short' })
}

const SIGNUP_RULE_FIELDS: Record<string, MessageKey> = {
  codesPerAddressHour: msg('admin.bills.signupRules.field.codesPerAddressHour'),
  codesPerAddressDay: msg('admin.bills.signupRules.field.codesPerAddressDay'),
  signupsPerIpHour: msg('admin.bills.signupRules.field.signupsPerIpHour'),
  signupsPerIpDay: msg('admin.bills.signupRules.field.signupsPerIpDay'),
  codesPerInstallHour: msg('admin.bills.signupRules.field.codesPerInstallHour'),
  pendingDays: msg('admin.bills.signupRules.field.pendingDays'),
  trialWorkspacesCloud: msg('admin.bills.signupRules.field.trialWorkspacesCloud'),
  trialNumbersPerWorkspace: msg('admin.bills.signupRules.field.trialNumbersPerWorkspace'),
  turnstile: msg('admin.bills.signupRules.turnstile'),
  blockedDomains: msg('admin.bills.signupRules.blockedDomains'),
  reviewRiskLevels: msg('admin.bills.signupRules.reviewRiskLevels'),
}
const RISK_NAMES: Record<string, MessageKey> = {
  normal: msg('admin.bills.risk.normal'),
  elevated: msg('admin.bills.risk.elevated'),
  highest: msg('admin.bills.risk.highest'),
  not_assessed: msg('admin.bills.risk.notAssessed'),
  unknown: msg('admin.bills.risk.unknown'),
}

/** What a sign-up limits change changed: "Days to finish Checkout 7 to 3; Bot check on to off". */
const signupRuleChangeList = (changes: NonNullable<AuditEntry['ruleChanges']>) => {
  const value = (field: string, v: unknown): string => {
    if (typeof v === 'boolean') return t(v ? 'admin.audit.signupRule.on' : 'admin.audit.signupRule.off')
    if (typeof v === 'number') return fmt().number(v)
    if (Array.isArray(v)) {
      if (!v.length) return t('admin.audit.signupRule.none')
      const names =
        field === 'reviewRiskLevels' ? v.map(l => (RISK_NAMES[l] ? t(RISK_NAMES[l]) : String(l))) : v.map(String)
      return fmt().list(names, { type: 'conjunction' })
    }
    return String(v ?? '')
  }
  const parts = changes.map(({ field, from, to }) => {
    const key = SIGNUP_RULE_FIELDS[field]
    const name = key ? t(key) : field
    if (field === 'blockedDomains' && Array.isArray(from) && Array.isArray(to)) {
      const added = to.filter(d => !from.includes(d)).length
      const removed = from.filter(d => !to.includes(d)).length
      return t('admin.audit.signupRule.domains', { field: name, added, removed })
    }
    return t('admin.audit.signupRule.change', { field: name, from: value(field, from), to: value(field, to) })
  })
  return fmt().list(parts, { type: 'unit', style: 'short' })
}

/** A spending cap in dollars, without cents when it is whole ("$50", "$12.50"). */
const usd = (value: unknown) => {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return String(value)
  return fmt().currency(amount, 'USD', { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 })
}

/** A webhook URL's host only: its path or query can carry a bearer token (the API sends only the host already). */
const hostOf = (url: unknown): { host: string; known: string } => {
  let host = ''
  try {
    host = new URL(String(url)).host
  } catch {
    host = typeof url === 'string' && url && !url.includes('/') ? url : ''
  }
  return { host, known: known(host) }
}

/** Which notification settings a change named: "email for every call, setup emails". */
const notificationFields: Record<string, MessageKey> = {
  email: msg('admin.audit.notification.email'),
  assignedEmail: msg('admin.audit.notification.assignedEmail'),
  setupEmails: msg('admin.audit.notification.setupEmails'),
  pushSummary: msg('admin.audit.notification.pushSummary'),
}
const changedFields = (input: Record<string, unknown>) => {
  const names = Object.keys(notificationFields)
    .filter(key => input[key] !== undefined)
    .map(key => t(notificationFields[key]!))
  return names.length ? fmt().list(names, { type: 'unit', style: 'short' }) : t('admin.audit.notification.none')
}

const today = () => new Date().toISOString().slice(0, 10)
/** The day after, so "to" includes the whole day picked. */
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

export function AuditLog({ workspaces }: { workspaces: AdminWorkspace[] }) {
  const t = useT()
  const [filter, setFilter] = useState<{
    kind: AuditKind | 'all'
    who: string
    workspace: string
    from: string
    to: string
  }>({
    kind: 'all',
    who: '',
    workspace: 'all',
    from: '',
    to: '',
  })
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const query = useCallback(
    (before?: string): AuditFilter => ({
      ...(filter.kind !== 'all' ? { kind: filter.kind } : {}),
      ...(filter.who.trim() ? { who: filter.who.trim() } : {}),
      ...(filter.workspace !== 'all' ? { workspace: filter.workspace } : {}),
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: dayAfter(filter.to) } : {}),
      ...(before ? { before } : {}),
    }),
    [filter],
  )

  useEffect(() => {
    let live = true
    setEntries(null)
    setError(null)
    // Typing a name waits a moment before asking.
    const timer = setTimeout(() => {
      loadAudit(query()).then(
        page => {
          if (!live) return
          setEntries(page.entries)
          setNext(page.next)
        },
        err => live && setError(errorText(err)),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  async function older() {
    if (!next) return
    setLoadingMore(true)
    try {
      const page = await loadAudit(query(next))
      setEntries(e => [...(e ?? []), ...page.entries])
      setNext(page.next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const set =
    <K extends keyof typeof filter>(key: K) =>
    (value: (typeof filter)[K]) =>
      setFilter(f => ({ ...f, [key]: value }))
  const workspaceOptions: SelectOption<string>[] = [
    { value: 'all', label: t('admin.audit.allWorkspaces') },
    ...workspaces.map(w => ({ value: w.id, label: w.name })),
  ]

  return (
    <div className="adm-card">
      <div className="adm-audit-filters">
        <Select
          value={filter.kind}
          options={kinds.map(k => ({ value: k.value, label: t(k.label) }))}
          onChange={set('kind')}
          label={t('admin.audit.column.what')}
        />
        <Input
          className="adm-audit-who"
          value={filter.who}
          onChange={e => set('who')(e.target.value)}
          placeholder={t('admin.audit.personPlaceholder')}
          aria-label={t('admin.audit.person')}
        />
        <Select
          value={filter.workspace}
          options={workspaceOptions}
          onChange={set('workspace')}
          label={t('admin.audit.column.workspace')}
        />
        <DateInput
          value={filter.from}
          max={filter.to || today()}
          onChange={set('from')}
          placeholder={t('admin.audit.from')}
          aria-label={t('admin.audit.from')}
        />
        <DateInput
          value={filter.to}
          min={filter.from || undefined}
          max={today()}
          onChange={set('to')}
          placeholder={t('admin.audit.to')}
          aria-label={t('admin.audit.to')}
        />
      </div>
      {(error || entries === null) && (
        <Loading
          what={t('admin.audit.loadingWhat')}
          loading
          error={error}
          onRetry={() => setFilter(f => ({ ...f }))}
          skeleton={<SkeletonRows rows={8} columns={4} className="adm-sk-rows" />}
        />
      )}
      {!error && entries && entries.length === 0 && <p className="adm-notice">{t('admin.audit.empty')}</p>}
      {!error && entries && entries.length > 0 && (
        <div className="adm-scroll">
          <table className="adm-table adm-stack">
            <thead>
              <tr>
                <th scope="col">{t('admin.audit.column.when')}</th>
                <th scope="col">{t('admin.audit.column.who')}</th>
                <th scope="col">{t('admin.audit.column.what')}</th>
                <th scope="col">{t('admin.audit.column.workspace')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td data-label={t('admin.audit.column.when')}>
                    <time
                      dateTime={e.at}
                      title={fmt().dateTime(new Date(e.at), { dateStyle: 'full', timeStyle: 'long' })}
                    >
                      {dateTimeLabel(new Date(e.at))}
                    </time>
                  </td>
                  <th scope="row">
                    {e.actor.email ?? (e.actor.id ? e.actor.id : t('admin.audit.commandLine'))}
                    {e.impersonatedBy && (
                      <span className="adm-sub">
                        {t('admin.audit.impersonatedBy', {
                          email: e.impersonatedBy.email ?? '',
                          known: e.impersonatedBy.email ? 'yes' : 'no',
                        })}
                      </span>
                    )}
                    {e.viaSetupKey && <span className="adm-sub">{t('admin.audit.viaSetupKey')}</span>}
                  </th>
                  <td data-label={t('admin.audit.column.what')}>
                    {auditLabel(e)}
                    {e.refused && (
                      <>
                        {' '}
                        <Badge tone="danger">{t('admin.audit.refused')}</Badge>
                      </>
                    )}
                    {auditReason(e) && <span className="adm-sub">{auditReason(e)}</span>}
                    {e.ipAddress && <span className="adm-sub">{e.ipAddress}</span>}
                  </td>
                  <td data-label={t('admin.audit.column.workspace')}>
                    {e.workspace ? (e.workspace.name ?? e.workspace.id) : EMPTY}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="adm-audit-more">
          <Button
            busy={loadingMore}
            size="sm"
            disabled={loadingMore}
            onClick={() => void older()}
            title={t('admin.audit.olderTip')}
          >
            {t('admin.audit.older')}
          </Button>
        </div>
      )}
    </div>
  )
}
