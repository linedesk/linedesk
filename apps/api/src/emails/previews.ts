// Every email with demo data (Brightwater Plumbing & Heating), for the preview script and the tests.

import { adminAlertEmail, adminSignInAlert, installTestEmail, providerFailureAlert, settingsChangedAlert, spendingCapEmail } from './alerts.ts'
import type { RenderedEmail } from './layout.ts'
import {
  addedToWorkspaceEmail,
  bookingConfirmationEmail,
  callEmail,
  confirmationCodeEmail,
  emailChangeCodeEmail,
  emailChangeConfirmCurrentEmail,
  emailChangedEmail,
  emailChangeRefusedEmail,
  firstCallEmail,
  invitationEmail,
  PARTNER_DIRECTORY_URL,
  passkeyChangedEmail,
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

const WORKSPACE_ID = 'ws_demo'

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
  booking: { what: 'Emergency repair', at: '2026-11-10T21:00:00Z' },
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
          booking: null,
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
          booking: null,
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
      email: signInCodeEmail('482913', origin, locale, `${origin}/#sign-in=Zm9yLXRoZS1wcmV2aWV3LW9ubHktbm90LWEtcmVhbC10b2tlbg`),
    },
    { name: 'sign-in-code-only', email: signInCodeEmail('482913', origin, locale) },
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
        providerFailureAlert('ElevenLabs', 'quota', 'quota_exceeded: This request exceeds your quota of 10000.')(locale),
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
    { name: 'welcome', email: welcomeEmail({ name: 'Sam Patel', email: 'sam@example.com' }, origin, locale) },
    { name: 'passkey-added', email: passkeyChangedEmail('added', origin, locale) },
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
