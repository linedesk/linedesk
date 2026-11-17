import { describe, expect, test } from 'vitest'
import { auditLabel, auditReason } from './AuditLog.tsx'

const label = (what: string, input: unknown = {}, subject: string | null = null) =>
  auditLabel({ what, method: null, input, subject: subject ? { email: subject } : null })
const transfers = (what: string, changes: { added?: string[]; changed?: string[]; removed?: string[] }) =>
  auditLabel({
    what,
    method: null,
    input: {},
    subject: null,
    transferChanges: { added: [], changed: [], removed: [], ...changes },
  })

describe('audit labels', () => {
  test('a change of the recording notice says what changed (A4)', () => {
    expect(label('workspace.updateSettings', { recordingNoticeOn: false })).toBe(
      'Turned off the recording notice callers hear',
    )
    expect(label('workspace.updateSettings', { recordingNoticeOn: true })).toBe(
      'Turned on the recording notice callers hear',
    )
    expect(label('workspace.updateSettings', { recordingNotice: '[omitted]' })).toBe(
      'Changed the recording notice callers hear',
    )
  })
  test('changes of transfer contacts say whom; the countries say which', () => {
    expect(transfers('assistant.update', { added: ['Sarah', 'Ana'], removed: ['Mike'] })).toBe(
      'Changed the transfer contacts (added Sarah and Ana, removed Mike)',
    )
    expect(transfers('assistant.update', {})).toBe('Changed the transfer contacts (new order)')
    expect(transfers('assistant.restoreVersion', { changed: ['Mike'] })).toBe(
      'Restored an earlier assistant version, which changed the transfer contacts (changed Mike)',
    )
    // A refused change has no result: its input had the contacts.
    expect(label('assistant.update', { transfers: [{ id: 'oncall', name: 'Mike', number: '…0199' }] })).toBe(
      'Changed the transfer contacts',
    )
    // An assistant change without one (done by an AI agent or while signed in as someone) says what it changed.
    expect(label('assistant.update', { greeting: 'Hi' })).toBe("Changed the assistant's settings")
    expect(label('assistant.restoreVersion', { versionId: 'v1' })).toBe('Restored an earlier assistant version')
    expect(label('outboundCountries.set', { countries: ['CA', 'MX'] })).toBe('Allowed calls to other countries: CA, MX')
    expect(label('outboundCountries.set', { countries: [] })).toBe('Allowed no calls to other countries')
  })

  test('a change of the call email instruction names who it added and removed, never the text', () => {
    const routing = (changes: { added: string[]; removed: string[] }) =>
      auditLabel({ what: 'assistant.update', method: null, input: {}, subject: null, emailRoutingChanges: changes })
    expect(routing({ added: ['Dave', 'rosa@lakeside-books.example'], removed: ['Mike'] })).toBe(
      'Changed who gets call emails (added Dave and rosa@lakeside-books.example, removed Mike)',
    )
    expect(routing({ added: [], removed: [] })).toBe('Changed who gets call emails')
    // A refused change has no result: its input had the instruction (redacted).
    expect(label('assistant.update', { email_routing: '[redacted]' })).toBe('Changed who gets call emails')
  })

  test('a change of what the calls cost names the models before and after', () => {
    const level = (what: string) =>
      auditLabel({
        what,
        method: null,
        input: {},
        subject: null,
        usageLevelChange: {
          before: { voice_model: null, llm_model: 'gpt-5.4-mini', voice_pipeline: null },
          after: { voice_model: 'elevenlabs/eleven_v3', llm_model: 'gpt-5.4', voice_pipeline: null },
        },
      })
    expect(level('assistant.update')).toBe(
      "Changed what the assistant's calls cost (voice model default to elevenlabs/eleven_v3, language model gpt-5.4-mini to gpt-5.4)",
    )
    expect(level('assistant.restoreVersion')).toMatch(/^Restored an earlier assistant version, which changed what its calls cost/)
    const ultra = auditLabel({
      what: 'assistant.update',
      method: null,
      input: {},
      subject: null,
      usageLevelChange: {
        before: { voice_model: null, llm_model: null, voice_pipeline: null, realtime_model: null },
        after: { voice_model: null, llm_model: null, voice_pipeline: 'realtime', realtime_model: 'gpt-realtime-2' },
      },
    })
    expect(ultra).toBe("Changed what the assistant's calls cost (pipeline default to realtime, realtime model default to gpt-realtime-2)")
  })

  test('branding says when Powered by Linedesk was hidden', () => {
    expect(label('branding.set', { name: 'Front Desk', starPrompt: true, poweredBy: true })).toBe(
      'Changed the branding to “Front Desk”',
    )
    expect(label('branding.set', { name: 'Front Desk', starPrompt: true, poweredBy: false })).toBe(
      'Changed the branding to “Front Desk”, Powered by Linedesk hidden',
    )
  })

  test('team and membership changes say whom they were about', () => {
    expect(label('team.setRole', { memberId: 'm1', role: 'admin' }, 'ana@example.com')).toBe(
      'Made ana@example.com an admin',
    )
    expect(label('membership.setRole', { memberId: 'm1', role: 'owner' }, 'ana@example.com')).toBe(
      'Made ana@example.com owner',
    )
    expect(label('team.removeMember', { memberId: 'm1' }, 'ana@example.com')).toBe(
      'Removed ana@example.com from the workspace',
    )
    expect(label('membership.add', { role: 'owner' }, 'op@example.com')).toBe('Added op@example.com as owner')
    expect(label('team.revokeInvite', {}, 'new@example.com')).toBe('Revoked the invitation to new@example.com')
    expect(label('team.leave')).toBe('Left the workspace')
    // Entries recorded before the subject was kept still read as a sentence.
    expect(label('team.removeMember', { memberId: 'm1' })).toBe('Removed a member from the workspace')
  })

  test("an owner's or admin's changes to a teammate say whom and what", () => {
    expect(label('team.updateMemberProfile', { memberId: 'm1', name: 'Sam' }, 'sam@example.com')).toBe(
      'Changed the name of sam@example.com',
    )
    expect(label('team.setMemberAvatar', { memberId: 'm1', avatar: '[redacted]' }, 'sam@example.com')).toBe(
      'Changed the picture of sam@example.com',
    )
    expect(label('team.removeMemberAvatar', { memberId: 'm1' }, 'sam@example.com')).toBe(
      'Removed the picture of sam@example.com',
    )
    expect(
      label('team.updateMemberNotifications', { memberId: 'm1', email: false, setupEmails: true }, 'sam@example.com'),
    ).toBe('Changed the notifications of sam@example.com (email for every call, setup emails)')
  })

  test('Add user says whom, as what, and server admin', () => {
    expect(
      label('user.invite', { email: 'ana@example.com', workspaceId: 'w1', role: 'admin' }, 'ana@example.com'),
    ).toBe('Added ana@example.com as an admin')
    expect(label('user.invite', { email: 'op@example.com', admin: true, workspaceId: null })).toBe(
      'Added op@example.com as server admin',
    )
    expect(label('user.invite', { email: 'op@example.com', admin: true, workspaceId: 'w1', role: 'owner' })).toBe(
      'Added op@example.com as owner and server admin',
    )
    // Entries from before Add user had a workspace.
    expect(label('user.invite', { email: 'old@example.com' })).toBe('Added old@example.com')
  })

  test('API keys and webhooks', () => {
    expect(label('apiKey.create', { name: 'Zapier', role: 'member' })).toBe('Created API key “Zapier”')
    expect(label('apiKey.revoke', { apiKeyId: 'k' })).toBe('Revoked an API key')
    expect(label('agentSetup.endOwnAccess', {})).toBe('AI agent ended its own setup link')
    // Only the host: a webhook URL's path or query can carry a bearer token.
    expect(label('webhook.create', { url: 'https://hooks.example.com/x?token=secret' })).toBe(
      'Added a webhook to hooks.example.com',
    )
    expect(label('webhook.update', { enabled: false })).toBe('Changed a webhook')
  })
})

// A copy of the keys of AUDITED_ACTIONS (apps/api/src/audit.ts): add a new audited action here and give it a label.
const AUDITED_ACTION_NAMES = [
  'provider.setKeys', 'provider.clearKeys', 'provider.setActive', 'provider.connectOneKey', 'carrier.set',
  'carrier.provisionTransferTrunk', 'voiceCloning.set', 'voicePipelinePolicy.set', 'systemPrompt.setPart', 'systemPrompt.resetPart', 'afterCallTranscript.set', 'setupEmails.set', 'user.invite',
  'user.disable', 'user.enable', 'workspace.disable', 'workspace.enable', 'workspace.delete', 'workspace.purge', 'data.purgeDeleted', 'call.erase', 'workspace.setSpendingCap',
  'instanceAdmin.grant', 'instanceAdmin.revoke', 'user.resetPasskeys', 'user.issuePasskeyEnrolment', 'branding.set',
  'user.impersonate', 'impersonation.stop', 'impersonationEmails.set', 'team.invite', 'team.resendInvite', 'team.revokeInvite', 'team.setRole',
  'team.transferOwnership', 'team.removeMember', 'team.leave', 'team.updateMemberProfile', 'team.setMemberAvatar',
  'team.removeMemberAvatar', 'team.updateMemberNotifications', 'workspace.deleteOwn', 'invitation.accept',
  'invitation.decline', 'membership.add', 'workspace.create', 'membership.setRole', 'membership.remove',
  'invitation.revoke', 'invitation.resend', 'apiKey.create', 'apiKey.revoke', 'webhook.create', 'webhook.update',
  'webhook.delete', 'webhook.test', 'calendar.connectFinish', 'calendar.disconnect', 'app.connectFinish', 'app.disconnect',
  'app.updateSettings', 'phoneNumber.setup',
  'phoneNumber.release', 'agentSetup.createKey', 'agentSetup.confirmPasskey', 'agentSetup.withdrawPasskey',
  'agentSetup.revoke', 'agentSetup.endOwnAccess', 'agentSetup.createWorkspaceKey', 'agentSetup.revokeWorkspace',
  'billingEnabled.set', 'billing.reprocessEvent', 'billing.credit', 'billing.refund', 'billing.adminSetStatus',
  'billing.setCap', 'billing.setConcurrency', 'billing.moveWorkspace', 'billing.transferOwner', 'billing.reviewHold',
  'billingRules.set', 'signup.setSelfServe', 'signup.setRules', 'account.signUp', 'billing.startCheckout',
  'billing.confirmCheckout', 'billing.startTopUp', 'billing.cancel', 'billing.resume', 'billing.setAutoRecharge',
  'billing.setRechargeCap', 'billing.openPortal', 'billing.retryRecharge', 'billing.recordPortOut', 'billing.handOver',
  'billing.portOutInfo',
]

describe('Server admin › Billing', () => {
  test('money actions name the amount; the rest say what changed', () => {
    expect(label('billing.credit', { kind: 'credit', amountCents: 1250 })).toBe('Credited $12.50 to a bill')
    expect(label('billing.credit', { kind: 'writeoff', amountCents: 500 })).toBe('Wrote off $5 of a bill')
    expect(label('billing.credit', { kind: 'adjustment', amountCents: -300 })).toBe('Adjusted a bill by -$3')
    expect(label('billing.refund', { amountCents: 2000 })).toBe('Refunded $20 to the card')
    expect(label('billing.adminSetStatus', { status: 'suspended' })).toBe('Suspended a bill')
    expect(label('billing.setConcurrency', { concurrentCalls: null })).toBe(
      "Set a bill's calls at once back to the rules",
    )
    expect(label('billing.reviewHold', { decision: 'deny' })).toBe('Denied a bill held for review')
    expect(label('signup.setSelfServe', { on: true })).toBe('Turned self-serve sign-up on')
    expect(label('signup.setRules', { rules: { turnstile: false } })).toBe('Changed the sign-up limits')
    expect(label('billing.confirmCheckout', { sessionId: 'cs_test_1' })).toBe('Came back from Stripe Checkout')
    expect(label('billing.startTopUp', { amountCents: 2000 })).toBe('Opened Checkout to buy $20 of minutes')
  })
})

describe('every audited action reads as words', () => {
  test.each(AUDITED_ACTION_NAMES)('%s has a label', what => {
    // Words, never the raw action name ("Ran billing.confirmCheckout").
    expect(label(what)).not.toContain(what)
    expect(label(what, { name: 'Brightwater Plumbing & Heating' }, 'mike@example.com')).not.toBe(what)
  })

  test('server admin, setup link, calendar and number entries', () => {
    expect(label('instanceAdmin.grant', { userId: 'u1' })).toBe('Made someone a server admin')
    expect(label('user.disable', { userId: 'u1' })).toBe('Disabled a user')
    // Since E4 their handlers keep whom it was about.
    expect(label('instanceAdmin.grant', { userId: 'u1' }, 'mike@example.com')).toBe(
      'Made mike@example.com a server admin',
    )
    expect(label('instanceAdmin.revoke', { userId: 'u1' }, 'mike@example.com')).toBe(
      'Removed mike@example.com as server admin',
    )
    expect(label('user.disable', { userId: 'u1' }, 'mike@example.com')).toBe('Disabled mike@example.com')
    expect(label('user.enable', { userId: 'u1' }, 'mike@example.com')).toBe('Enabled mike@example.com')
    expect(label('workspace.setSpendingCap', { workspaceId: 'w1', capUsd: 50 })).toBe('Set the spending cap to $50')
    expect(label('workspace.setSpendingCap', { workspaceId: 'w1', capUsd: null })).toBe('Removed the spending cap')
    expect(label('workspace.create', { name: 'Brightwater Plumbing & Heating' }, 'mike@example.com')).toBe(
      'Created the workspace “Brightwater Plumbing & Heating” with owner mike@example.com',
    )
    expect(label('workspace.deleteOwn', { name: 'Brightwater Plumbing & Heating' })).toBe(
      'Owner deleted the workspace “Brightwater Plumbing & Heating”',
    )
    expect(label('workspace.purge', { name: 'Brightwater Plumbing & Heating' })).toBe(
      'Deleted the workspace “Brightwater Plumbing & Heating” 90 days after its plan was canceled',
    )
    expect(label('data.purgeDeleted', { calls: 3, contacts: 1 })).toBe(
      'Erased 3 deleted calls and 1 deleted contact 30 days after they were deleted',
    )
    expect(label('call.erase', { calls: 1, recordings: 1 })).toBe('Deleted a call permanently')
    expect(label('agentSetup.createKey')).toBe('Created an AI agent setup link')
    expect(label('calendar.connectFinish', { provider: 'google', state: '[redacted]' })).toBe(
      'Connected a Google calendar',
    )
    expect(label('app.connectFinish', { app: 'hubspot', state: '[redacted]', code: '[redacted]' })).toBe(
      'Connected HubSpot',
    )
    expect(label('app.disconnect', { app: 'hubspot' })).toBe('Disconnected HubSpot')
    expect(label('app.updateSettings', { id: 'appc_1', settings: { create_contacts: false } })).toBe(
      'Changed what Linedesk does in a connected app',
    )
    expect(label('phoneNumber.setup', { areaCode: '503', purchase: true })).toBe('Bought a phone number')
    expect(label('phoneNumber.setup', { e164: '+15035550142', purchase: false })).toBe('Connected a phone number')
  })
})

test('an invitation passed to the owner names the invited address (LIN-264)', () => {
  expect(auditLabel({ what: 'invitation_reassigned', method: 'new@example.com', input: null, subject: null })).toBe(
    "Invitation to new@example.com passed to the workspace owner: its sender's account was deleted",
  )
  // The owner it passed to, while that account exists (review F4).
  expect(auditLabel({ what: 'invitation_reassigned', method: 'new@example.com', input: null, subject: { email: 'mike@example.com' } })).toBe(
    "Invitation to new@example.com passed to the workspace owner mike@example.com: its sender's account was deleted",
  )
})

test("a removed member's invitation that the removal canceled (LIN-264 review F1)", () => {
  expect(auditLabel({ what: 'invitation_withdrawn', method: 'new@example.com', input: null, subject: null })).toBe(
    'Invitation to new@example.com canceled: its sender was removed from the workspace',
  )
})

test('entries without a name, an address or a host still read as a sentence', () => {
  expect(label('branding.set', { poweredBy: false })).toBe('Changed the branding, Powered by Linedesk hidden')
  expect(label('apiKey.create', {})).toBe('Created an API key')
  expect(label('workspace.create', {})).toBe('Created the workspace')
  expect(label('webhook.create', { url: 'not a url/' })).toBe('Added a webhook to a URL')
  expect(label('provider.setActive', { provider: 'deepgram', category: 'stt' })).toBe('Picked deepgram for stt')
  expect(label('provider.setActive', {})).toBe('Picked none for a category')
  expect(label('membership.add', { role: 'admin' })).toBe('Added a member as an admin')
  expect(label('team.updateMemberNotifications', { pushSummary: true })).toBe(
    'Changed the notifications of a member (push summary)',
  )
  expect(label('team.updateMemberNotifications', {})).toBe('Changed the notifications of a member (none)')
  expect(label('workspace.setSpendingCap', { capUsd: 12.5 })).toBe('Set the spending cap to $12.50')
  expect(auditLabel({ what: 'sign_in', method: 'email_code', input: null, subject: null })).toBe(
    'Signed in with email code',
  )
  expect(auditLabel({ what: 'provider_linked', method: 'github', input: null, subject: null })).toBe(
    'Added GitHub sign-in',
  )
})

describe('signing in as a user', () => {
  test('names whom it was and shows the reason; older entries without either still read', () => {
    expect(label('user.impersonate', { userId: 'u1', reason: 'Ticket 7' }, 'mike@example.com')).toBe(
      'Signed in as mike@example.com',
    )
    expect(label('user.impersonate', { userId: 'u1' })).toBe('Signed in as a user')
    expect(auditReason({ what: 'user.impersonate', input: { userId: 'u1', reason: ' Ticket 7 ' } })).toBe(
      'Reason: Ticket 7',
    )
    expect(auditReason({ what: 'user.impersonate', input: { userId: 'u1' } })).toBeNull()
    expect(auditReason({ what: 'team.invite', input: { reason: 'x' } })).toBeNull()
    expect(auditReason({ what: 'billing.refund', input: { amountCents: 500, reason: 'Duplicate charge' } })).toBe(
      'Reason: Duplicate charge',
    )
    expect(label('impersonationEmails.set', { on: true })).toBe('Turned on emails to users when an admin signs in as them')
  })
})

describe('what setup links, support access and its API keys did', () => {
  // apps/api/src/setup-mcp.ts SETUP_ACTIONS (the writes, which the command log keeps) and what its handlers run; the
  // writes of support access (impersonation-guard.ts IMPERSONATION_ALLOWED_WRITES, READS_LOGGED_WHEN_IMPERSONATED); the
  // public actions an API key made during support access can run.
  const canAppear = [
    'provider.setKeys', 'provider.setActive', 'provider.connectOneKey', 'provider.clearKeys', 'install.setProgress',
    'workspace.rename', 'workspace.setIcon', 'workspace.removeIcon', 'assistant.update', 'workspace.updateSettings',
    'businessHours.set', 'notifications.update', 'phoneNumber.setup', 'phoneNumber.update', 'phoneNumber.checkForwarding',
    'onboarding.setStep', 'workspace.create', 'agentSetup.endOwnAccess',
    'impersonation.stop', 'apiKey.create', 'apiKey.revoke', 'call.export',
    'call.markDone', 'call.markNotDone', 'call.markRead', 'call.markUnread', 'call.remind', 'call.assign',
    'call.clearReminder', 'call.delete', 'call.restore', 'call.markSpam', 'call.markNotSpam', 'call.setActionItems',
    'call.setUrgency', 'contact.update', 'contact.block', 'contact.unblock', 'contact.create', 'contact.delete',
    'contact.restore', 'appointment.book', 'appointment.cancel', 'appointment.reschedule',
  ]

  test('each has a sentence of its own, never the action id', () => {
    for (const what of canAppear) {
      const text = label(what)
      expect(text, what).not.toContain(what)
      expect(text, what).not.toMatch(/^Ran /)
    }
  })

  test('onboarding steps, notifications and renames say what changed', () => {
    expect(label('onboarding.setStep', { step: 'skipped' })).toBe('Set the onboarding aside')
    expect(label('onboarding.setStep', { step: 'phone' })).toBe('Moved on in the onboarding')
    expect(label('notifications.update', { email: true })).toBe('Changed their notifications (email for every call)')
    expect(label('workspace.rename', { name: 'Brightwater' })).toBe('Renamed the workspace to “Brightwater”')
    expect(label('call.markRead', { callId: 'c1' })).toBe('Marked a call read')
  })

  test('a revoked API key is named, like a created one', () => {
    expect(auditLabel({ what: 'apiKey.revoke', method: null, input: { apiKeyId: 'k1' }, subject: null, apiKeyName: 'Zapier' })).toBe(
      'Revoked API key “Zapier”',
    )
    expect(label('apiKey.revoke', { apiKeyId: 'k1' })).toBe('Revoked an API key')
  })

  test('any other action still reads as a sentence that names it', () => {
    expect(label('knowledge.update')).toBe('Ran knowledge.update')
  })
})

test('a sign-up limits change shows each value before and after', () => {
  const entry = (ruleChanges: { field: string; from: unknown; to: unknown }[]) =>
    auditLabel({ what: 'signup.setRules', method: null, input: { rules: {} }, subject: null, ruleChanges })
  expect(
    entry([
      { field: 'pendingDays', from: 7, to: 3 },
      { field: 'turnstile', from: true, to: false },
      { field: 'reviewRiskLevels', from: ['elevated', 'highest'], to: [] },
      { field: 'blockedDomains', from: ['a.com'], to: ['b.com', 'c.com'] },
    ]),
  ).toBe(
    'Changed the sign-up limits (Days to finish Checkout 7 to 3, Bot check (Cloudflare Turnstile) on to off, Hold for review at Radar risk Elevated and Highest to none, Blocked email domains 2 added, 1 removed)',
  )
  expect(entry([])).toBe('Changed the sign-up limits')
})
