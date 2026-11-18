// Every screen a signed-in person can reach while setting up or joining (2026-11-18) offers the account menu in its top
// bar (SetupAccountMenu): another workspace or partner area, and Sign out. The screens have no app navigation, so
// without it someone could be stuck on one. They get it one of three ways: the setup pages' one top bar
// (SetupTopBar.tsx: the onboarding's frame, the install walkthrough, the agent setup pages, a partner's setup and area), the menu itself, or the
// sign-in card page with it in its corner once signed in (SignedInAuthPage.tsx). A new screen in the list below, or one built on the bare AuthPage, fails here.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

const SRC = new URL('..', import.meta.url).pathname
const source = (file: string) => readFileSync(join(SRC, file), 'utf8')

/** The setup and joining screens, by the file that renders each; what renders the menu for it. */
const SETUP_SCREENS: Record<string, string> = {
  // Cloud trial and step-by-step onboarding (its steps: business, assistant, pick-up, notify, activate, phone, done),
  // and the same steps again from the settings.
  'onboarding/Onboarding.tsx': '<Frame',
  'onboarding/StepByStep.tsx': '<Frame',
  'onboarding/Frame.tsx': '<SetupTopBar',
  // The agent setup pages: install (#setup-agent), workspace owner, partner (#partner/agent), change with the agent.
  'onboarding/AgentSetup.tsx': '<SetupTopBar',
  'partner/PartnerAgentSetup.tsx': '<AgentSetup',
  'settings/ChangeWithAgent.tsx': '<AgentSetup',
  // Self-hosted first run: the install walkthrough by hand.
  'onboarding/InstallSetup.tsx': '<SetupTopBar',
  'onboarding/AdminStart.tsx': '<SignedInAuthPage',
  // A white-label partner: the guided setup by hand (#partner/setup) and the partner area (#partner).
  'partner/PartnerSetup.tsx': '<SetupTopBar',
  'partner/PartnerArea.tsx': '<SetupTopBar',
  // Joining: a team invitation, a partner team invitation, no workspace yet, a new workspace.
  'team/AcceptInvite.tsx': '<SignedInAuthPage',
  'partner/PartnerInvite.tsx': '<SignedInAuthPage',
  'NoWorkspace.tsx': '<SignedInAuthPage',
  'CreateWorkspace.tsx': '<SignedInAuthPage',
  // Sign-up's "about you" once the email code is confirmed, Checkout's way back, a passkey, a second sign-in step.
  'Signup.tsx': '<SignedInAuthPage',
  'CheckoutReturn.tsx': '<SignedInAuthPage',
  'AddPasskey.tsx': '<SignedInAuthPage',
  'admin/SecondFactorPrompt.tsx': '<SignedInAuthPage',
  // Connecting an AI agent (OAuth consent for MCP).
  'integrations/ConnectAgent.tsx': '<SignedInAuthPage',
}

/** Where the menu itself is drawn, for the screens that reach it through them. */
const MENU_HOSTS = ['onboarding/SetupTopBar.tsx', 'shell/SignedInAuthPage.tsx']

/** Pages before signing in: the bare card page, no account to show. */
const SIGNED_OUT_ONLY = new Set(['Login.tsx', 'SignInLink.tsx', 'shell/SignedInAuthPage.tsx'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [relative(SRC, path)] : []
  })
}

test('each setup and joining screen renders the account menu, or a page that does', () => {
  for (const [file, via] of Object.entries(SETUP_SCREENS)) expect(source(file), `${file} uses ${via}`).toContain(via)
  for (const host of MENU_HOSTS) expect(source(host), `${host} draws the menu`).toContain('<SetupAccountMenu')
})

test('no signed-in screen uses the bare card page: it has no account menu', () => {
  const bare = files(SRC).filter(file => !SIGNED_OUT_ONLY.has(file) && source(file).includes('<AuthPage'))
  expect(bare).toEqual([])
})
