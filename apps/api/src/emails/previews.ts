// Every email with demo data (Brightwater Plumbing & Heating), for the preview script and the tests.

import {
  adminAlertEmail,
  adminSignInAlert,
  installTestEmail,
  partnerBrandChangedAlert,
  providerFailureAlert,
  settingsChangedAlert,
  spendingCapEmail,
} from './alerts.ts'
import { billingOwnerEmail } from './billing.ts'
import { managerChangedEmail } from './billing-lifecycle.ts'
import { partnerDomainAddedAlert, partnerDomainEmail } from './partner.ts'
import type { RenderedEmail } from './layout.ts'
import {
  addedNoticeEmail,
  addedToWorkspaceEmail,
  assignedCallEmail,
  authenticatorChangedEmail,
  bookingConfirmationEmail,
  type CallEmail,
  callEmail,
  confirmationCodeEmail,
  emailChangeCodeEmail,
  emailChangeConfirmCurrentEmail,
  emailChangedEmail,
  emailChangeRefusedEmail,
  firstCallEmail,
  invitationEmail,
  memberAddedByAdminEmail,
  outsideConfirmEmail,
  partnerInvitationEmail,
  PARTNER_DIRECTORY_URL,
  passkeyChangedEmail,
  personalKeyCreatedEmail,
  passkeyEnrolmentIssuedEmail,
  passkeysResetEmail,
  impersonationStartedEmail,
  impersonationApiKeyEmail,
  passwordChangedEmail,
  passwordResetCodeEmail,
  setupDay0Email,
  setupNudgeEmail,
  signInCodeEmail,
  weekSummaryEmail,
  welcomeEmail,
  slotInZone,
  workspaceDeletedEmail,
} from './templates.ts'

export type Preview = { name: string; email: RenderedEmail }

/** A monthly trial that ends on Dec 1: the first charge is the plan only. */
const trial = {
  planCents: 1100,
  interval: 'month' as const,
  trialEnd: '2026-12-01T17:00:00.000Z',
  workspaceId: 'ws_demo',
  bufferMicros: 0,
}

/** The trial prompt's facts: $25 with a Visa ending in 4242, topped up below $5, free until Dec 1, $0.05 a minute. */
const trialMinutes = {
  includedMinutes: 50,
  amountCents: 2500,
  thresholdCents: 500,
  card: { brand: 'visa', last4: '4242' },
  freeUntil: trial.trialEnd,
  standardMicrosPerMinute: 50_000,
  workspaceId: 'ws_demo',
  bufferMicros: 0,
}

const WORKSPACE_ID = 'ws_demo'

// Who changed the bill (a workspace admin), where and when.
// i18n-ignore: demo data (a teammate's and the business's names as people wrote them), never translated
const managerChange = {
  name: 'Dana Lee',
  email: 'dana@brightwater.example',
  workspace: 'Brightwater Plumbing & Heating',
  at: '2026-11-14T17:05:00Z',
  timeZone: 'America/Los_Angeles',
}

/** The partner block of day 3 shows in the previews whether or not this install has a partner directory. */
const partners = PARTNER_DIRECTORY_URL ?? 'https://linedesk.ai/partners'

// i18n-ignore: demo data (Brightwater Plumbing & Heating): what a business and its callers wrote, never translated
const call = {
  workspaceId: WORKSPACE_ID,
  callId: 'call_demo_01',
  title: 'Water heater leaking in the basement',
  summary:
    'Sarah noticed water pooling under the water heater this morning. It is a 12-year-old 50 gallon gas tank. She turned off the cold-water supply but the floor is still wet and she is worried about the drywall.',
  urgent: true,
  fromNumber: '+15035550142',
  callerName: 'Sarah Chen',
  assistantName: 'Maya',
  startedAt: '2026-11-10T16:42:00Z',
  durationSec: 214,
  timeZone: 'America/Los_Angeles',
  nextSteps: ['Confirm the technician can bring a replacement tank', 'Text Sarah the arrival window'],
  fields: [
    { label: 'Address', value: '2140 SE Division St, Portland' },
    { label: 'Water heater', value: '50 gal gas, about 12 years old' },
  ],
  booking: { what: 'Emergency repair', at: '2026-11-10T21:00:00Z' },
  transcript: [
    { speaker: 'agent', text: 'Thanks for calling Brightwater Plumbing & Heating, this is Maya. How can I help?' },
    { speaker: 'caller', text: 'Hi, my water heater is leaking. There is water all over the basement floor.' },
    { speaker: 'agent', text: 'I am sorry to hear that. Did you turn off the water supply to the tank?' },
    { speaker: 'caller', text: 'Yes, the cold-water valve is off, but the floor is still wet.' },
    { speaker: 'agent', text: 'Good. I can book an emergency repair today at 1 PM. Does that work?' },
    { speaker: 'caller', text: 'Yes, please. This is Sarah Chen.' },
  ] as CallEmail['transcript'],
  workspace: 'Brightwater Plumbing & Heating',
}

// i18n-ignore: demo data, as above
const setup = {
  workspaceId: WORKSPACE_ID,
  workspace: 'Brightwater Plumbing & Heating',
  assistantName: 'Maya',
  numberId: 'pn_preview',
  number: '+15035550142',
  takesAllCalls: false,
  step: 'forwarding' as const,
}

/** Every email in `locale` (a UI language; English by default). */
export function previewEmails(origin: string, locale?: string | null): Preview[] {
  const booked = { what: call.booking.what, when: slotInZone(call.booking.at, call.timeZone, locale) }
  // i18n-ignore: demo data (names, summaries, addresses as people wrote them); every other word comes from t()
  return [
    { name: 'call-summary', email: callEmail({ ...call, booking: booked }, origin, locale) },
    {
      name: 'call-summary-plain',
      email: callEmail(
        {
          ...call,
          title: 'Quote for a bathroom remodel',
          summary: 'Wants a quote for replacing the tub with a walk-in shower. Flexible on timing, prefers mornings.',
          urgent: false,
          callerName: null,
          fromNumber: '+15035550177',
          nextSteps: ['Call back with a site-visit time'],
          fields: [],
          booking: null,
          transcript: [],
        },
        origin,
        locale,
      ),
    },
    { name: 'setup-day0', email: setupDay0Email(setup, origin, null, locale) },
    { name: 'setup-day1', email: setupNudgeEmail(1, setup, origin, null, PARTNER_DIRECTORY_URL, locale) },
    {
      name: 'setup-day1-no-number',
      email: setupNudgeEmail(
        1,
        { ...setup, numberId: null, number: null, step: 'number' },
        origin,
        null,
        PARTNER_DIRECTORY_URL,
        locale,
      ),
    },
    { name: 'setup-day3', email: setupNudgeEmail(3, setup, origin, null, partners, locale) },
    {
      name: 'setup-day3-test',
      email: setupNudgeEmail(3, { ...setup, step: 'first_call' }, origin, null, partners, locale),
    },
    {
      name: 'first-call',
      email: firstCallEmail(
        {
          ...call,
          title: 'Dripping shower valve',
          summary:
            'Dana has a shower valve that keeps dripping after it is turned off. Wants a callback after 4 pm to set up a visit.',
          urgent: false,
          callerName: 'Dana Whitaker',
          fromNumber: '+15035550154',
          nextSteps: ['Call Dana back after 4 pm'],
          fields: [{ label: 'Best time to call', value: 'After 4 pm' }],
          booking: null,
          transcript: [
            {
              speaker: 'agent',
              text: 'Thanks for calling Brightwater Plumbing & Heating, this is Maya. How can I help?',
            },
            { speaker: 'caller', text: 'Hi, this is Dana Whitaker. My shower keeps dripping after I turn it off.' },
            { speaker: 'agent', text: 'I can have someone call you back to set up a visit. When is a good time?' },
            { speaker: 'caller', text: 'After 4 pm, please.' },
          ],
        },
        origin,
        locale,
      ),
    },
    {
      name: 'week-summary',
      email: weekSummaryEmail(
        {
          workspaceId: WORKSPACE_ID,
          workspace: setup.workspace,
          assistantName: 'Maya',
          calls: 9,
          urgent: 2,
          booked: 3,
          messages: 4,
        },
        origin,
        null,
        locale,
      ),
    },
    {
      name: 'sign-in-code',
      email: signInCodeEmail(
        '482913',
        origin,
        locale,
        `${origin}/#sign-in=Zm9yLXRoZS1wcmV2aWV3LW9ubHktbm90LWEtcmVhbC10b2tlbg`,
      ),
    },
    { name: 'sign-in-code-only', email: signInCodeEmail('482913', origin, locale) },
    // The same code from the sign-up page, for an address without an account yet.
    {
      name: 'sign-up-code',
      email: signInCodeEmail(
        '482913',
        origin,
        locale,
        `${origin}/signup#sign-in=Zm9yLXRoZS1wcmV2aWV3LW9ubHktbm90LWEtcmVhbC10b2tlbg`,
        { signUp: true },
      ),
    },
    { name: 'password-reset-code', email: passwordResetCodeEmail('815302', origin, locale) },
    { name: 'confirmation-code', email: confirmationCodeEmail('730514', origin, origin, locale) },
    {
      name: 'admin-alert',
      email: adminAlertEmail(
        adminSignInAlert({
          who: 'ann@brightwater.example',
          method: 'passkey',
          browser: { browser: 'Chrome', os: 'macOS' },
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
          address: '203.0.113.9',
          at: '2026-11-14T17:05:00Z',
        })(locale),
        origin,
        locale,
      ),
    },
    {
      name: 'admin-alert-provider-failure',
      email: adminAlertEmail(
        providerFailureAlert(
          'ElevenLabs',
          'quota',
          'quota_exceeded: This request exceeds your quota of 10000.',
        )(locale),
        origin,
        locale,
      ),
    },
    {
      name: 'admin-alert-settings-agent',
      email: adminAlertEmail(
        settingsChangedAlert({
          change: 'switched',
          provider: 'Resend',
          actor: { email: 'ann@brightwater.example' },
          agent: { prefix: 'lds_7Qp2', createdAt: '2026-11-14T16:40:00Z' },
        })(locale),
        origin,
        locale,
      ),
    },
    {
      name: 'spending-cap-80',
      email: spendingCapEmail(
        { workspace: 'Brightwater Plumbing & Heating', level: 80, capUsd: 50, spentUsd: 40.2 },
        origin,
        locale,
      ),
    },
    {
      name: 'spending-cap-100',
      email: spendingCapEmail(
        { workspace: 'Brightwater Plumbing & Heating', level: 100, capUsd: 50, spentUsd: 50.35 },
        origin,
        locale,
      ),
    },
    { name: 'install-test', email: installTestEmail('204816', origin, locale) },
    {
      name: 'invitation',
      email: invitationEmail(
        {
          inviter: 'Mike Brennan',
          workspace: 'Brightwater Plumbing & Heating',
          email: 'sam@example.com',
          url: `${origin}/?invite=preview`,
          days: 7,
        },
        origin,
        locale,
      ),
    },
    {
      name: 'partner-invitation',
      email: partnerInvitationEmail(
        {
          inviter: 'Mike Brennan',
          partner: 'Cascade IT Partners',
          email: 'sam@example.com',
          url: `${origin}/#partner-invite=preview`,
          days: 7,
          role: 'admin',
        },
        origin,
        locale,
      ),
    },
    {
      name: 'added-to-workspace',
      email: addedToWorkspaceEmail(
        {
          inviter: 'Mike Brennan',
          workspace: 'Brightwater Plumbing & Heating',
          email: 'sam@example.com',
          url: `${origin}/?invite=preview`,
          days: 7,
          role: 'member',
        },
        origin,
        locale,
      ),
    },
    {
      name: 'outside-confirm',
      email: outsideConfirmEmail(
        {
          inviter: 'Mike Brennan',
          workspace: 'Brightwater Plumbing & Heating',
          email: 'office@example.com',
          url: `${origin}/email-recipient/confirm?t=preview`,
          days: 7,
          stopUrl: `${origin}/email-recipient/stop?t=preview`,
        },
        origin,
        locale,
      ),
    },
    {
      name: 'added-notice',
      email: addedNoticeEmail(
        { admin: 'Ann Lee', workspace: 'Brightwater Plumbing & Heating', workspaceId: WORKSPACE_ID, role: 'member' },
        origin,
        locale,
      ),
    },
    {
      name: 'member-added-by-admin',
      email: memberAddedByAdminEmail(
        {
          admin: 'Ann Lee',
          who: 'Sam Patel',
          workspace: 'Brightwater Plumbing & Heating',
          workspaceId: WORKSPACE_ID,
          role: 'member',
          pending: false,
        },
        origin,
        locale,
      ),
    },
    {
      name: 'assigned-call',
      email: assignedCallEmail(
        {
          workspaceId: WORKSPACE_ID,
          callId: call.callId,
          title: call.title,
          summary: call.summary,
          urgent: false,
          fromNumber: call.fromNumber,
          callerName: call.callerName,
          assignedBy: 'Mike Brennan',
          workspace: call.workspace,
        },
        origin,
        locale,
      ),
    },
    { name: 'authenticator-added', email: authenticatorChangedEmail('added', origin, locale) },
    {
      name: 'admin-alert-partner-brand',
      email: adminAlertEmail(
        partnerBrandChangedAlert({
          partner: 'Cascade IT Partners',
          name: 'Cascade Desk',
          approvedName: 'Cascade Phones',
          logoUrl: `${origin}/v1/branding/partners/ptn_demo/logo.png?v=3f9a2c1d`,
          supportEmail: 'help@cascade-it.example',
          termsUrl: 'https://cascade-it.example/terms',
          privacyUrl: 'https://cascade-it.example/privacy',
          color: '#0f766e',
          reviewUrl: `${origin}/#admin/partners`,
        })(locale),
        origin,
        locale,
      ),
    },
    {
      name: 'admin-alert-partner-domain',
      email: adminAlertEmail(
        partnerDomainAddedAlert({
          partner: 'Cascade IT Partners',
          hostname: 'app.cascade-it.example',
          brandName: 'Cascade Desk',
          reviewUrl: `${origin}/#admin/partners`,
        })(locale),
        origin,
        locale,
      ),
    },
    {
      name: 'partner-domain-live',
      email: partnerDomainEmail({ kind: 'live', hostname: 'app.cascade-it.example' }, origin, locale),
    },
    {
      name: 'partner-domain-failed',
      email: partnerDomainEmail({ kind: 'failed', hostname: 'app.cascade-it.example' }, origin, locale),
    },
    {
      name: 'partner-domain-removed',
      email: partnerDomainEmail(
        { kind: 'removed', hostname: 'app.cascade-it.example', reason: 'Imitates a bank' },
        origin,
        locale,
      ),
    },
    {
      name: 'partner-domain-expired',
      email: partnerDomainEmail({ kind: 'expired', hostname: 'app.cascade-it.example' }, origin, locale),
    },
    { name: 'welcome', email: welcomeEmail({ name: 'Sam Patel', email: 'sam@example.com' }, origin, locale) },
    { name: 'passkey-added', email: passkeyChangedEmail('added', origin, locale) },
    {
      name: 'personal-key-created',
      email: personalKeyCreatedEmail('Laptop command line', 'ldp_AbCd1234', origin, locale),
    },
    { name: 'passkeys-reset', email: passkeysResetEmail(2, origin, locale) },
    {
      name: 'impersonation-started',
      email: impersonationStartedEmail(
        {
          admin: { name: 'Ann Lee', email: 'ann@brightwater.example' },
          reason: 'Ticket 1042: calls not showing in the inbox',
          at: '2026-11-14T17:05:00Z',
          workspace: 'Brightwater Plumbing & Heating',
          minutes: 60,
        },
        origin,
        locale,
      ),
    },
    {
      name: 'impersonation-api-key',
      email: impersonationApiKeyEmail(
        {
          admin: { name: 'Ann Lee', email: 'ann@brightwater.example' },
          keyName: 'Zapier support',
          prefix: 'ld_3fK9aQ2x',
          role: 'member',
          at: '2026-11-14T17:12:00Z',
          workspace: 'Brightwater Plumbing & Heating',
        },
        origin,
        locale,
      ),
    },
    { name: 'passkey-enrolment-issued', email: passkeyEnrolmentIssuedEmail('ann@brightwater.example', origin, locale) },
    { name: 'password-changed', email: passwordChangedEmail(origin, locale) },
    { name: 'email-change-confirm-current', email: emailChangeConfirmCurrentEmail('318274', origin, locale) },
    { name: 'email-change-code', email: emailChangeCodeEmail('604218', origin, locale) },
    { name: 'email-change-refused', email: emailChangeRefusedEmail(origin, locale) },
    { name: 'email-changed', email: emailChangedEmail('mike.brennan@brightwater.example', origin, locale) },
    {
      name: 'workspace-deleted',
      email: workspaceDeletedEmail(
        {
          workspace: 'Brightwater Plumbing & Heating',
          by: 'Mike Brennan',
          at: '2026-11-14T17:05:00Z',
          timeZone: 'America/Los_Angeles',
          accountDeleted: true,
        },
        origin,
        locale,
      ),
    },
    {
      name: 'removed-account-deleted',
      email: workspaceDeletedEmail(
        {
          workspace: 'Brightwater Plumbing & Heating',
          by: 'Mike Brennan (mike@brightwater.example)',
          at: '2026-11-14T17:05:00Z',
          timeZone: 'America/Los_Angeles',
          accountDeleted: true,
          removed: true,
        },
        origin,
        locale,
      ),
    },
    // The trial's emails: its confirmation at activation, then the reminders 7 days and 1 day
    // before the first charge, and the day-3 nudge to a sign-up that has not started it.
    {
      name: 'trial-started',
      email: billingOwnerEmail({ ...trial, kind: 'trial_started', reminderDays: [7, 1] }, origin, locale),
    },
    {
      name: 'trial-reminder-7-days',
      email: billingOwnerEmail({ ...trial, kind: 'trial_will_end', daysBefore: 7 }, origin, locale),
    },
    {
      name: 'trial-reminder-1-day',
      email: billingOwnerEmail({ ...trial, kind: 'trial_will_end', daysBefore: 1 }, origin, locale),
    },
    // Before the trial: day 3 of a sign-up that has not started it (one step left).
    {
      name: 'trial-setup-nudge',
      email: billingOwnerEmail(
        {
          kind: 'activation_nudge',
          bufferMicros: trial.bufferMicros,
          workspaceId: trial.workspaceId,
          workspace: 'Brightwater Plumbing & Heating',
          assistant: 'Maya',
          trialDays: 14,
          deleteOn: '2026-12-01T09:00:00Z',
        },
        origin,
        locale,
      ),
    },
    // A caller heard a busy line (LIN-450): all 5 calls at the same time were in use; more can be added.
    {
      name: 'busy-line',
      email: billingOwnerEmail(
        {
          kind: 'busy_line',
          bufferMicros: trial.bufferMicros,
          workspaceId: trial.workspaceId,
          workspace: 'Brightwater Plumbing & Heating',
          day: '2026-11-17',
          callers: 3,
          limit: 5,
          next: 'add',
          step: 5,
          stepCents: 500,
          partnerBill: false,
        },
        origin,
        locale,
      ),
    },
    // A workspace admin who manages the bill changed it: its owner hears of it (bill-manager.ts).
    {
      name: 'bill-changed-by-admin-cancel',
      email: managerChangedEmail(
        { ...managerChange, change: 'cancel', endsAt: '2026-12-01T09:00:00Z' },
        trial.workspaceId,
        origin,
        locale,
      ),
    },
    {
      name: 'bill-changed-by-admin-card',
      email: managerChangedEmail(
        { ...managerChange, change: 'paymentMethod', card: { brand: 'visa', last4: '4242' } },
        trial.workspaceId,
        origin,
        locale,
      ),
    },
    // In the trial, most of its included minutes used, then all of them.
    {
      name: 'trial-minutes-low',
      email: billingOwnerEmail({ ...trialMinutes, kind: 'trial_minutes_low', usedMinutes: 40 }, origin, locale),
    },
    {
      name: 'trial-minutes-used',
      email: billingOwnerEmail({ ...trialMinutes, kind: 'trial_minutes_used', usedMinutes: 50 }, origin, locale),
    },
    {
      name: 'plan-minutes-low',
      email: billingOwnerEmail(
        { ...trialMinutes, kind: 'trial_minutes_low', usedMinutes: 40, paid: true, freeUntil: null },
        origin,
        locale,
      ),
    },
    {
      name: 'booking-confirmation',
      email: bookingConfirmationEmail(
        {
          business: 'Brightwater Plumbing & Heating',
          what: 'repair visit',
          when: slotInZone('2026-11-17T17:00:00Z', 'America/Los_Angeles', locale),
          minutes: 60,
          address: '2140 SE Division St, Portland, OR 97202',
          phone: '+15035550100',
        },
        origin,
        locale,
      ),
    },
  ]
}
