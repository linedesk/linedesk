// Shown instead of the admin area when an instance admin must sign in again (docs/architecture.md §12):
// the sign-in is too old (1 hour, 12 with a passkey), or the email address is not confirmed yet; also
// when that happens while Admin is open (AdminMode). The reload after signing in keeps the address,
// so it returns to the same admin page. Any sign-in
// method this install offers works; the new session opens the admin area.
import { useEffect } from 'react'
import { type AdminSecondFactor, fetchMe } from '../auth.ts'
import { Login } from '../Login.tsx'

type Props = { state: AdminSecondFactor; onExit: () => void }

const PROMPT: Record<AdminSecondFactor, { title: string; why: string }> = {
  confirm: {
    title: 'Sign in again for Admin',
    why: 'For your security, Admin needs a recent sign-in: 1 hour with an email code, password or provider, 12 hours with a passkey.',
  },
  email: {
    title: 'Confirm your email for Admin',
    why: 'Admin needs a confirmed email address. Continue with Email: signing in with the code confirms it.',
  },
}

export function SecondFactorPrompt({ state, onExit }: Props) {
  // The app's account data is loaded once: after signing in again in another tab, ask again on the way in.
  useEffect(() => {
    let current = true
    void fetchMe().then(me => {
      if (current && me && (me.adminSecondFactor ?? null) !== state) window.location.reload()
    })
    return () => {
      current = false
    }
  }, [state])

  // A new session: load the app again with it. The form stays busy until then.
  const reload = async () => {
    window.location.reload()
    await new Promise(() => {})
  }
  return <Login reauth={{ ...PROMPT[state], onBack: onExit }} onDone={reload} />
}
