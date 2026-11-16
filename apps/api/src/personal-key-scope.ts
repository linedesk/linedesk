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

export const PERSONAL_KEY_REFUSED: ReadonlyMap<string, string> = new Map([
  ['personalKey.create', KEYS],
  ['personalKey.list', KEYS],
  ['personalKey.revoke', KEYS],
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
])

/** Why a personal key may not run `name`, or null when it may (if its maker may). */
export const personalKeyRefusal = (name: string) => PERSONAL_KEY_REFUSED.get(name) ?? null
