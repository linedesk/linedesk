// What a personal key (personal-keys.ts) does not do, though its maker may (LIN-339). Everything else in the registry
// that the maker's permissions allow runs with the key, over POST /v1/actions/<name>, MCP and the CLI; the coverage
// test (test/ui-parity.test.ts) fails when an action is neither reachable that way nor listed here with its reason.
// Some actions also refuse parts of their input to a key (an enrolment code, the billing keys, a number on the
// install's account): their handlers say so (admin-handlers.ts, billing-settings.ts, number-purchases.ts).

const KEYS = 'a key never makes, lists or ends keys or setup links: do it in the app, signed in as yourself'
const SIGN_IN = 'this changes how you sign in: do it in the app'
const BROWSER = 'this works only in the browser'
const FRESH_SIGN_IN = 'this needs a fresh sign-in in the app'
const OWNER_IN_APP = 'what the workspace pays is decided by the owner, signed in to the app'
const INTEGRATIONS = 'integrations (Zapier) subscribe with a workspace API key'
const MONEY = 'money and billing rules are changed in the app, signed in as yourself with your passkey'
const SIGN_UP_PAGE = 'a business signs up on the sign-up page, signed in with an email code'

export const PERSONAL_KEY_REFUSED: ReadonlyMap<string, string> = new Map([
  ['personalKey.create', KEYS],
  ['personalKey.list', KEYS],
  ['personalKey.revoke', KEYS],
  // OAuth sign-in of an MCP client: the person approves it in the browser, signed in as themselves (oauth.ts).
  ['oauth.describe', KEYS],
  ['oauth.approve', KEYS],
  ['apiKey.create', KEYS],
  ['apiKey.list', KEYS],
  ['apiKey.revoke', KEYS],
  ['agentSetup.createKey', KEYS],
  ['agentSetup.createWorkspaceKey', KEYS],
  ['agentSetup.revoke', KEYS],
  ['agentSetup.revokeWorkspace', KEYS],
  // A setup key ends its own link with it; a person uses agentSetup.revoke.
  ['agentSetup.endOwnAccess', KEYS],
  ['account.authenticatorStart', SIGN_IN],
  ['account.authenticatorConfirm', SIGN_IN],
  ['account.authenticatorCheck', SIGN_IN],
  ['account.authenticatorRemove', SIGN_IN],
  // Switches the browser's session to another user and back.
  ['user.impersonate', BROWSER],
  ['impersonation.stop', BROWSER],
  // Push subscriptions belong to a browser; listening in and taking over play the call's audio there.
  ['push.subscribe', BROWSER],
  ['push.unsubscribe', BROWSER],
  ['call.listen', BROWSER],
  ['call.takeOver', BROWSER],
  ['starPrompt.answer', BROWSER],
  ['workspace.deleteOwn', FRESH_SIGN_IN],
  ['workspace.setAllowPremium', OWNER_IN_APP],
  ['workspace.setAllowUltra', OWNER_IN_APP],
  ['integration.subscribe', INTEGRATIONS],
  ['integration.unsubscribe', INTEGRATIONS],
  // Server admin › Billing writes (billing-admin.ts refuseMoneyChange; security review of #919, H1 and I3).
  ['billing.credit', MONEY],
  ['billing.refund', MONEY],
  ['billing.adminSetStatus', MONEY],
  ['billing.setCap', MONEY],
  ['billing.setConcurrency', MONEY],
  ['billing.moveWorkspace', MONEY],
  ['billing.transferOwner', MONEY],
  ['billing.reviewHold', MONEY],
  ['billing.reprocessEvent', MONEY],
  ['billingRules.set', MONEY],
  ['signup.setSelfServe', MONEY],
  // Self-serve sign-up (docs/billing.md §3.1): only POST /v1/signup grants account.signUp, and only to a session.
  ['account.signUp', SIGN_UP_PAGE],
  // Trial Checkout (docs/billing.md §3.2): payments and the plan are the owner's, in the app.
  ['billing.startCheckout', OWNER_IN_APP],
  ['billing.confirmCheckout', OWNER_IN_APP],
  ['billing.startTopUp', OWNER_IN_APP],
  ['billing.cancel', OWNER_IN_APP],
  ['billing.resume', OWNER_IN_APP],
])

/** Why a personal key may not run `name`, or null when it may (if its maker may). */
export const personalKeyRefusal = (name: string) => PERSONAL_KEY_REFUSED.get(name) ?? null
