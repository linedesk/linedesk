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
  ['agentSetup.createPartnerKey', KEYS],
  ['agentSetup.revokePartner', KEYS],
  // A setup key ends its own link with it; a person uses agentSetup.revoke.
  ['agentSetup.endOwnAccess', KEYS],
  ['account.authenticatorStart', SIGN_IN],
  ['account.authenticatorConfirm', SIGN_IN],
  ['account.authenticatorCheck', SIGN_IN],
  ['account.authenticatorRemove', SIGN_IN],
  // Switches the browser's session to another user and back.
  ['user.impersonate', BROWSER],
  ['impersonation.stop', BROWSER],
  // Edits during an impersonation belong to that browser session (impersonation-guard.ts).
  ['impersonation.setEdits', BROWSER],
  // Push subscriptions belong to a browser; listening in and taking over play the call's audio there.
  ['push.subscribe', BROWSER],
  ['push.unsubscribe', BROWSER],
  ['call.listen', BROWSER],
  ['call.takeOver', BROWSER],
  ['starPrompt.answer', BROWSER],
  ['workspace.deleteOwn', FRESH_SIGN_IN],
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
  ['signup.setRules', MONEY],
  // Self-serve sign-up: only POST /v1/signup grants account.signUp, and only to a session.
  ['account.signUp', SIGN_UP_PAGE],
  // A new terms version (LIN-420): accepted in the app's dialog by the person, with their session's address.
  ['account.acceptTerms', BROWSER],
  // Trial Checkout: payments and the plan are the owner's, in the app.
  ['billing.startCheckout', OWNER_IN_APP],
  ['billing.confirmCheckout', OWNER_IN_APP],
  ['billing.startTopUp', OWNER_IN_APP],
  ['billing.cancel', OWNER_IN_APP],
  ['billing.resume', OWNER_IN_APP],
  // Settings › Billing (PR 9): the overview holds invoice links (bearer links), the rest changes what is charged.
  ['billing.overview', OWNER_IN_APP],
  ['billing.setAutoRecharge', OWNER_IN_APP],
  ['billing.setRechargeCap', OWNER_IN_APP],
  ['billing.setExtraCalls', OWNER_IN_APP],
  ['billing.setInterval', OWNER_IN_APP],
  ['billing.openPortal', OWNER_IN_APP],
  ['billing.retryRecharge', OWNER_IN_APP],
  // A workspace admin's usage view (billing tour G3, security review of #1098, L-2): billing stays in the app, like the
  // owner's overview; no key reads billing figures (workspace keys and setup links are refused by the handler).
  ['billing.workspaceUsage', BROWSER],
  // White-label partner team (docs/white-label.md): the partner permission is a browser session's only (context.ts).
  ['partner.get', BROWSER],
  ['partner.update', BROWSER],
  ['partnerMember.invite', BROWSER],
  ['partnerMember.revokeInvite', BROWSER],
  ['partnerMember.remove', BROWSER],
  ['partnerInvitation.view', BROWSER],
  ['partnerInvitation.accept', BROWSER],
  ['partnerBrand.get', BROWSER],
  ['partnerBrand.set', BROWSER],
  ['workspace.createForClient', BROWSER],
  ['workspace.inviteClientOwner', BROWSER],
  ['partner.releaseClient', BROWSER],
  ['partner.deleteClient', BROWSER],
  ['partner.listClients', BROWSER],
  ['partner.setClientUsageLimit', BROWSER],
  ['partner.setClientCallQuality', BROWSER],
  // The partner's own provider keys (S7, partner-keys.ts): the owner, signed in recently, in the browser.
  ['partnerKeys.get', BROWSER],
  ['partnerKeys.set', BROWSER],
  ['partnerKeys.clear', BROWSER],
  ['partnerKeys.test', BROWSER],
  ['partner.setClientOwnKeys', BROWSER],
  // The partner's own sender address and its support email's proof (S6, partner-sender.ts): in the browser.
  ['partnerSender.get', BROWSER],
  ['partnerSender.add', BROWSER],
  ['partnerSender.check', BROWSER],
  ['partnerSender.sendTest', BROWSER],
  ['partnerSender.remove', BROWSER],
  ['partnerBrand.verifySupportEmail', BROWSER],
  ['partnerBrand.confirmSupportEmail', BROWSER],
  // The partner's own address (S5, partner-domain.ts): in the browser.
  ['partnerDomain.get', BROWSER],
  ['partnerDomain.add', BROWSER],
  ['partnerDomain.check', BROWSER],
  ['partnerDomain.remove', BROWSER],
  // The partner owner's setup progress (partner-setup.ts): the page and the partner setup link set it.
  ['partner.setSetupStep', BROWSER],
  // Moves what the workspace pays to its owner: only the owner, signed in (partners.ts).
  ['workspace.removePartner', BROWSER],
])

/** Why a personal key may not run `name`, or null when it may (if its maker may). */
export const personalKeyRefusal = (name: string) => PERSONAL_KEY_REFUSED.get(name) ?? null
