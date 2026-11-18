// The centred page (AuthPage) on screens someone reaches signed in: checking out, an invitation, a passkey, no
// workspace yet, the sign-up's last step. Like every setup page's top bar (SetupAccountMenu), it has the account menu
// at the top right: another workspace or the partner area, and Sign out. Nobody signed in yet (the sign-up's first
// steps, an invitation before signing in): no menu. None of these pages is a workspace's own, so the menu lists every
// workspace, the one the tab has open too (`away`): back from a partner's Checkout, its client workspace is a click away.
import type { ReactNode } from 'react'
import { auth } from '../auth.ts'
import { AuthPage } from '../ui/kit.tsx'
import { SetupAccountMenu } from './SetupAccountMenu.tsx'

/** `install`: the install's branding even in a white-label partner's client workspace (a partner's own page). */
export function SignedInAuthPage({ children, install }: { children: ReactNode; install?: boolean }) {
  const signedIn = !!auth.useSession().data?.user
  return (
    <AuthPage corner={signedIn ? <SetupAccountMenu away /> : undefined} install={install}>
      {children}
    </AuthPage>
  )
}
