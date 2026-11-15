// Every email with demo data (Brightwater Plumbing & Heating), for the preview script and the tests.

import { brandName } from '../branding.ts'
import type { RenderedEmail } from './layout.ts'
import {
  addedToWorkspaceEmail,
  adminAlertEmail,
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
  passwordChangedEmail,
  passwordResetCodeEmail,
  setupDay0Email,
  setupNudgeEmail,
  signInCodeEmail,
  weekSummaryEmail,
  welcomeEmail,
  workspaceDeletedEmail,
} from './templates.ts'

export type Preview = { name: string; email: RenderedEmail }

const WORKSPACE_ID = 'ws_demo'

/** The partner block of day 3 shows in the previews whether or not this install has a partner directory. */
const partners = PARTNER_DIRECTORY_URL ?? 'https://linedesk.ai/partners'

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
  booking: { what: 'Emergency repair', when: 'Tuesday, November 10 at 1:00 PM PST' },
  workspace: 'Brightwater Plumbing & Heating',
}

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
  return [
    { name: 'call-summary', email: callEmail(call, origin, locale) },
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
    { name: 'sign-in-code', email: signInCodeEmail('482913', origin, locale) },
    { name: 'password-reset-code', email: passwordResetCodeEmail('815302', origin, locale) },
    { name: 'confirmation-code', email: confirmationCodeEmail('730514', origin, origin, locale) },
    {
      name: 'admin-alert',
      email: adminAlertEmail(
        `Admin sign-in to ${brandName()}: ann@brightwater.example`,
        'ann@brightwater.example, an instance admin, signed in with a password from a device or address not seen before.\n\nAddress: 203.0.113.9\nBrowser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)\n\nIf this was not them, sign in with your passkey, then in Server admin › Users: disable the account and reset its passkeys.',
        origin,
        locale,
      ),
    },
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
          when: 'November 14, 2026 at 9:05 AM PST',
          accountDeleted: true,
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
          when: 'Tuesday, November 17 at 9:00 AM PST',
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
