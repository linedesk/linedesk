// The workspace rights audit as a test (LIN-246, docs/architecture.md "Workspace rights"): every action in the
// registry, by who may run it. A new action fails here until it is put in the right group, so nobody adds a setting
// members can change or a daily-work action members cannot. Owner: everything an admin can, plus deleting the workspace
// and handing it over. Admin: every workspace setting, the team except the owner, API keys, webhooks. Member: inbox,
// calls, contacts, reminders and appointments, their own profile and notifications; reading settings, never changing them.
import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { actions } from './index.ts'
import { type Right, rightOf, roleMeets, WORKSPACE_ROLES } from './rights.ts'

const expectedRights: Record<Right, readonly string[]> = {
  member: [
    'call.markDone',
    'call.markNotDone',
    'call.markRead',
    'call.markUnread',
    'call.remind',
    'call.assign',
    'member.list',
    'call.clearReminder',
    'call.delete',
    'call.restore',
    'call.markSpam',
    'call.markNotSpam',
    'call.setActionItems',
    'call.setUrgency',
    'call.listen',
    'call.takeOver',
    'contact.update',
    'contact.block',
    'contact.unblock',
    'contact.create',
    'contact.delete',
    'contact.restore',
    'contact.import',
    'contact.merge',
    // An API key's Zapier subscriptions (integrations.ts): a member key reads every call already (MCP, API).
    'integration.subscribe',
    'integration.unsubscribe',
    'voice.options',
    'voice.catalog',
    // Which countries transfer contacts may be in (outbound.ts): read like the other settings.
    'outbound.countries',
    'workspace.getSettings',
    'account.setAvatar',
    'account.removeAvatar',
    'holidays.lookup',
    'notifications.get',
    'notifications.update',
    'push.subscribe',
    'push.unsubscribe',
    'starPrompt.answer',
    // Feedback to the Linedesk team (LIN-639): everyone in the workspace, and every key and MCP client.
    'feedback.send',
    'calendar.findSlots',
    'appointment.book',
    'appointment.cancel',
    'appointment.reschedule',
    'team.list',
    'team.leave',
    'insights.get',
    // Reading rows through a key or MCP instead of the sync shapes (records.ts, LIN-339).
    'records.list',
    // Call emails (LIN-470): whether the rules are on, so members see the section as it works.
    'emailRouting.available',
  ],
  admin: [
    // Workspace settings › Billing for owners and admins: this workspace's usage only, read-only (docs/billing.md §8).
    'billing.workspaceUsage',
    'agentSetup.createWorkspaceKey',
    'agentSetup.revokeWorkspace',
    'call.export',
    'assistant.update',
    // Call email routing (LIN-369): who gets which call, and the outside addresses it may name.
    'emailRouting.get',
    'emailRecipient.add',
    'emailRecipient.resend',
    'emailRecipient.remove',
    'emailRecipient.restore',
    'assistant.create',
    'assistant.delete',
    'assistant.versions',
    'assistant.version',
    'assistant.restoreVersion',
    'voice.clone',
    'phoneNumber.setup',
    'phoneNumber.listCarrierNumbers',
    'phoneNumber.searchNearby',
    'phoneNumber.update',
    'phoneNumber.release',
    'phoneNumber.lookupLine',
    'phoneNumber.checkForwarding',
    'phoneNumber.forwardingCheck',
    'carrier.set',
    'carrier.get',
    'carrier.test',
    'assistant.startTestCall',
    // Also the workspace country and language (LIN-258): settings like the time zone, admins and the owner only.
    'workspace.updateSettings',
    'workspace.rename',
    'workspace.setIcon',
    'workspace.removeIcon',
    'businessHours.set',
    'closedDays.set',
    'holidays.set',
    'sample.add',
    'sample.remove',
    'notifications.setDefaults',
    'appointmentType.upsert',
    'appointmentType.delete',
    'calendar.connectStart',
    'calendar.connectFinish',
    'calendar.listCalendars',
    'calendar.disconnect',
    // Connected apps (apps.ts, docs/crm-sync.md): connecting HubSpot and the like is a workspace setting.
    'app.connectStart',
    'app.connectFinish',
    'app.disconnect',
    'mail.connectStart',
    'mail.connectFinish',
    'mail.disconnect',
    'app.pushes',
    // What Linedesk does in the app (LIN-367): log calls, add new callers, fill empty fields.
    'app.updateSettings',
    // Connecting a CalDAV, Calendly or Cal.com account with its key (only the tools Server admin switched on).
    'calendar.connectWithPassword',
    'assistantCalendar.add',
    'assistantCalendar.update',
    'assistantCalendar.setDefault',
    'assistantCalendar.remove',
    'apiKey.create',
    'apiKey.list',
    'apiKey.revoke',
    // Integration subscriptions in Integrations › Zapier, like the keys.
    'integration.list',
    'integration.remove',
    'team.invite',
    'team.resendInvite',
    'team.revokeInvite',
    'team.setRole',
    'team.removeMember',
    'team.getMember',
    'team.updateMemberProfile',
    'team.setMemberAvatar',
    'team.removeMemberAvatar',
    'team.updateMemberNotifications',
    'onboarding.setStep',
    'onboarding.recordEvent',
    'onboarding.goLiveChecklist',
    'onboarding.dismissGoLiveChecklist',
    'onboarding.reopenGoLiveChecklist',
    'onboarding.skipGoLiveStep',
    'onboarding.remindGoLiveStep',
    'onboarding.restoreGoLiveStep',
    'call.getEvaluation',
    'call.listEvaluations',
    'call.evaluate',
    'evaluation.markDone',
    'evaluation.reopen',
    'evaluation.listQuestions',
    'webhook.create',
    'webhook.update',
    'webhook.delete',
    'webhook.test',
    'webhook.deliveries',
    'knowledge.import',
    'knowledgeQuestion.answer',
    'knowledgeQuestion.dismiss',
    'business.search',
    'business.import',
    // What the workspace pays (billing:manage, owners and admins since 2026-11-17): the handlers let through only who
    // manages the bill (managesBill: its owner, or an owner or admin of the only workspace it pays for).
    // The bill's Checkout, Buy minutes, cancel and resume (docs/billing.md §3.2).
    'billing.startCheckout',
    'billing.confirmCheckout',
    'billing.startTopUp',
    'billing.cancel',
    'billing.resume',
    // The banner; port-out and hand-over stay with the bill's owner (the handlers check it).
    'billing.state',
    'billing.portOutInfo',
    'billing.handOver',
    // Settings › Billing (PR 9): the bill's page.
    'billing.overview',
    'billing.setAutoRecharge',
    'billing.setRechargeCap',
    'billing.setExtraCalls',
    'billing.setInterval',
    'billing.openPortal',
    'billing.retryRecharge',
  ],
  agent: [
    'call.start',
    'call.appendTranscript',
    'call.finish',
    'call.recordTimings',
    'call.reportVoiceFailure',
    'call.takeMessage',
    'call.flagUrgent',
    'call.startTest',
    'call.findForTest',
    'call.listNumbers',
    'call.startRecording',
    'call.setRecording',
    'call.correctTranscript',
    'call.finalize',
    'call.transfer',
    'carrier.transferTrunk',
    'carrier.provisionTransferTrunk',
    'provider.reportOk',
    'call.lookUpCaller',
    'call.askWebhook',
  ],
  'server-admin': [
    'voiceCloning.get',
    'voiceCloning.set',
    // German numbers held in the install's name (number-buy.ts).
    'germanNumbers.get',
    'germanNumbers.group',
    'germanNumbers.set',
    'callQuality.get',
    'callQuality.set',
    // The fixed parts of the assistant's system prompt, for the whole install (LIN-346).
    'systemPrompt.get',
    'systemPrompt.setPart',
    'systemPrompt.resetPart',
    'afterCallTranscript.get',
    'afterCallTranscript.set',
    // Billing through Stripe on or off for the install (docs/billing.md §7).
    'billingEnabled.get',
    'billingEnabled.set',
    'branding.set',
    // Which calendar tools (CalDAV, Calendly, Cal.com) businesses may connect, and how.
    'calendarTools.get',
    'calendarTools.set',
    'install.setProgress',
    'provider.tryOut',
    'provider.confirmEmail',
    'agentSetup.createKey',
    'agentSetup.revoke',
    'agentSetup.endOwnAccess',
    'account.authenticatorStart',
    'account.authenticatorConfirm',
    'account.authenticatorCheck',
    'account.authenticatorRemove',
    'provider.setKeys',
    'provider.clearKeys',
    'provider.setActive',
    'provider.test',
    'provider.connectOneKey',
    'user.invite',
    'user.disable',
    'user.enable',
    'workspace.disable',
    'workspace.delete',
    'workspace.enable',
    'workspace.setSpendingCap',
    'instanceAdmin.grant',
    'user.resetPasskeys',
    'user.issuePasskeyEnrolment',
    'instanceAdmin.revoke',
    'user.impersonate',
    'setupEmails.get',
    'setupEmails.set',
    'impersonationEmails.get',
    'impersonationEmails.set',
    'signupAccess.get',
    'signupAccess.set',
    'outboundCountries.get',
    'outboundCountries.set',
    'billing.reprocessEvent',
    // Server admin › Billing (docs/billing.md §11, PR 13).
    'billing.adminBills',
    'billing.adminBill',
    'billing.adminEvents',
    'billing.adminReview',
    'billing.adminSummary',
    'billingRules.get',
    'billing.adminTaxAddressMissing',
    'billingRules.set',
    'signup.getSelfServe',
    'signup.setSelfServe',
    'signup.setRules',
    'billing.credit',
    'billing.adminSetStatus',
    'billing.refund',
    'billing.setCap',
    'billing.setConcurrency',
    'billing.moveWorkspace',
    'billing.transferOwner',
    'billing.reviewHold',
    // Bill ownership and port-outs, by an instance admin (docs/billing.md §3.4, §8).
    'billing.recordPortOut',
    'workspace.create',
    'membership.add',
    'membership.setRole',
    'membership.remove',
    'invitation.revoke',
    'invitation.resend',
    // Server admin › Partners (docs/white-label.md).
    'partner.adminList',
    'partner.create',
    'partner.approve',
    'partner.suspend',
    'partner.setClientLimit',
    'partner.adminMoveClient',
    // Server admin › Partners › Protected names (docs/white-label.md, S4).
    'partnerBrand.protectedNames',
    'partnerBrand.setProtectedNames',
    // Server admin › Partners › Brands: a partner's brand reaches clients and emails once approved (security review of #1111, M-2).
    'partnerBrand.reviews',
    'partnerBrand.approve',
    'partnerBrand.reset',
    // Server admin › Partners: the kill switch of a partner's own AI keys (S7).
    'partnerKeys.adminDisable',
    'partnerKeys.adminEnable',
    // Server admin › Partners: removing a partner's own sender address (S6).
    'partnerSender.adminRemove',
    // Server admin › Partners: removing a partner's own address (S5).
    'partnerDomain.adminRemove',
  ],
  owner: [
    'workspace.deleteOwn',
    'workspace.deletePreview',
    'team.transferOwnership',
    // Removing the workspace's white-label partner (docs/white-label.md): the owner takes over what it pays.
    'workspace.removePartner',
  ],
  impersonation: ['impersonation.stop'],
  // The Stripe webhook's processor: the API's billing jobs only (docs/billing.md §8).
  system: ['billing.processStripeEvent', 'billing.settleInvoice'],
  // A person's own invitations and personal API keys (personal-keys.ts, LIN-339), and the keys MCP clients get by
  // OAuth sign-in (oauth.ts, LIN-126).
  account: [
    'invitation.listMine',
    'invitation.accept',
    'invitation.decline',
    'oauth.describe',
    'oauth.approve',
    'personalKey.create',
    'personalKey.list',
    'personalKey.revoke',
    'account.signUp',
    // A new terms version, accepted in the app by a bill's owner (LIN-420).
    'account.acceptTerms',
    // A partner team invitation (docs/white-label.md): its link, for the address it was sent to.
    'partnerInvitation.view',
    'partnerInvitation.accept',
  ],
  // A white-label partner's team (docs/white-label.md): the handlers check the caller is on the named partner's team.
  partner: [
    'partner.get',
    'partner.update',
    'partnerMember.invite',
    'partnerMember.revokeInvite',
    'partnerMember.remove',
    'workspace.createForClient',
    'workspace.inviteClientOwner',
    'partner.releaseClient',
    'partner.deleteClient',
    'partner.listClients',
    'partner.setClientUsageLimit',
    'partner.setClientCallQuality',
    // Partner › Brand (S4): read by the team, changed by the owner only (the handler checks).
    'partnerBrand.get',
    'partnerBrand.set',
    // Partner › AI keys (S7): read by the team, changed by the owner only (the handler checks).
    'partnerKeys.get',
    'partnerKeys.set',
    'partnerKeys.clear',
    'partnerKeys.test',
    'partner.setClientOwnKeys',
    // Partner › Email sender (S6): read by the team, changed by the owner only (the handler checks).
    'partnerSender.get',
    'partnerSender.add',
    'partnerSender.check',
    'partnerSender.sendTest',
    'partnerSender.remove',
    'partnerBrand.verifySupportEmail',
    'partnerBrand.confirmSupportEmail',
    // Partner › Domain (S5): read by the team, changed by the owner only (the handler checks).
    'partnerDomain.get',
    'partnerDomain.add',
    'partnerDomain.check',
    'partnerDomain.remove',
    // The partner owner's AI agent setup link (agent-first, 2026-11-18): the handler checks the owner.
    'agentSetup.createPartnerKey',
    'agentSetup.revokePartner',
    'partner.setSetupStep',
  ],
}

describe('workspace rights', () => {
  it('lists every action of the registry exactly once', () => {
    const listed = Object.values(expectedRights).flat()
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual([...actions.keys()].sort())
  })

  it.each(Object.entries(expectedRights).flatMap(([right, names]) => names.map(name => [name, right] as const)))(
    '%s needs %s',
    (name, right) => {
      expect(rightOf(actions.get(name)!.permission)).toBe(right)
    },
  )

  it('owner ⊃ admin ⊃ member: a higher role has every permission of a lower one', () => {
    for (const p of rolePermissions.member) expect(rolePermissions.admin).toContain(p)
    for (const p of rolePermissions.admin) expect(rolePermissions.owner).toContain(p)
    expect(roleMeets('owner', 'admin')).toBe(true)
    expect(roleMeets('admin', 'owner')).toBe(false)
    expect(roleMeets('member', 'admin')).toBe(false)
    expect(roleMeets('owner', 'server-admin')).toBe(false)
    expect(WORKSPACE_ROLES).toEqual(['member', 'admin', 'owner'])
  })

  it('the owner and admins give an AI agent a setup link for the workspace, members never', () => {
    expect(expectedRights.admin).toEqual(
      expect.arrayContaining(['agentSetup.createWorkspaceKey', 'agentSetup.revokeWorkspace']),
    )
  })

  it('members change no workspace setting: settings, team, keys and webhooks are for admins', () => {
    for (const name of expectedRights.member) {
      const def = actions.get(name)!
      expect(['settings:write', 'team:write', 'workspace:own', 'call:export'], name).not.toContain(def.permission)
    }
  })

  it('only the owner deletes the workspace or hands it over', () => {
    expect([...expectedRights.owner].sort()).toEqual([
      'team.transferOwnership',
      'workspace.deleteOwn',
      'workspace.deletePreview',
      'workspace.removePartner',
    ])
  })

  it('owners and admins decide what the workspace pays (billing:manage), members never', () => {
    expect(rolePermissions.admin).toContain('billing:manage')
    expect(rolePermissions.member).not.toContain('billing:manage')
    for (const name of [
      'billing.startCheckout',
      'billing.confirmCheckout',
      'billing.startTopUp',
      'billing.cancel',
      'billing.resume',
      'billing.overview',
      'billing.setAutoRecharge',
      'billing.setRechargeCap',
      'billing.setExtraCalls',
      'billing.setInterval',
      'billing.openPortal',
      'billing.retryRecharge',
    ])
      expect(actions.get(name)!.permission, name).toBe('billing:manage')
  })
})
